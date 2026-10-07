using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Shell;

namespace ChiefUpdater;

/// <summary>One button of a message state; Run is called on click.</summary>
sealed class PopupButton
{
    public PopupButton(string label, bool primary, Action run)
    {
        Label = label;
        Primary = primary;
        Run = run;
    }

    public string Label { get; }
    public bool Primary { get; }
    public Action Run { get; }
}

/// <summary>The popup's view: ApplyMode drives it; it only draws.</summary>
public partial class PopupWindow : Window
{
    /// <summary>The percentage the bar shows, eased toward the real one.</summary>
    static readonly DependencyProperty ShownProgressProperty = DependencyProperty.Register(
        "ShownProgress", typeof(double), typeof(PopupWindow), new PropertyMetadata(0.0, (d, e) => ((PopupWindow)d).OnShownProgress((double)e.NewValue)));

    static readonly Color Danger = Color.FromRgb(0xFF, 0x63, 0x69);
    static readonly Color TextPrimary = Color.FromRgb(0xED, 0xED, 0xEF);

    readonly Job job;
    readonly bool motion;
    readonly Color accent;
    readonly TaskCompletionSource<bool> shown = new();
    IntPtr hwnd;
    double target;
    bool indeterminate = true;
    bool allowClose;
    Storyboard? shimmer;

    internal PopupWindow(Job job)
    {
        this.job = job;
        // "Animation effects" off in Windows settings, or the app's own reduced-motion setting.
        motion = !job.ReducedMotion && SystemParameters.ClientAreaAnimation;
        accent = ParseColor(job.Accent) ?? Color.FromRgb(0xE5, 0x48, 0x4D);
        InitializeComponent();

        Resources["AccentBrush"] = Frozen(accent);
        // White on Chief's colour, unless the colour is so light that dark text reads better.
        Resources["OnAccentBrush"] = Frozen(Luminance(accent) > 0.55 ? Color.FromRgb(0x0F, 0x0F, 0x12) : Colors.White);
        Shimmer.Fill = ShimmerBrush(accent);

        string title = job.IsRollback ? $"Going back to {job.To}" : $"Updating {job.AssistantName}";
        Title = title;
        TitleText.Text = title;
        VersionText.Text = $"{job.From} → {job.To}";
        AutomationProperties.SetName(this, title);
        AutomationProperties.SetName(Face, job.AssistantName);
        Face.Source = LoadFace();
        PercentText.Text = "";

        SourceInitialized += OnSourceInitialized;
        Loaded += OnLoaded;
        ContentRendered += (_, _) =>
        {
            Native.SendMessage(hwnd, Native.WM_NCACTIVATE, new IntPtr(1), IntPtr.Zero);
            shown.TrySetResult(true);
        };
        DpiChanged += (_, _) => Dispatcher.BeginInvoke(new Action(Place));
        TrackHost.SizeChanged += (_, _) => OnTrackResized();
        Surface.MouseLeftButtonDown += (_, e) =>
        {
            if (e.ButtonState == MouseButtonState.Pressed) DragMove();
        };
        // Closing it mid-install would leave Chief closed; only a finished state (or a button) closes it.
        Closing += (_, e) => e.Cancel = !allowClose;
    }

    /// <summary>Completes once the popup has been drawn on screen.</summary>
    internal Task Shown => shown.Task;

    double ShownProgress
    {
        get => (double)GetValue(ShownProgressProperty);
        set => SetValue(ShownProgressProperty, value);
    }

    // ---- Window setup --------------------------------------------------------------------------------------------

    void OnSourceInitialized(object? sender, EventArgs e)
    {
        hwnd = new WindowInteropHelper(this).Handle;
        // WPF paints its background black by default; transparent lets the DWM backdrop through.
        var source = HwndSource.FromHwnd(hwnd)!;
        source.CompositionTarget!.BackgroundColor = Colors.Transparent;
        source.AddHook(KeepFrameActive);
        // Without a system menu DWM draws no caption buttons into the extended frame (and Alt+Space does nothing).
        int style = Native.GetWindowLong(hwnd, Native.GWL_STYLE);
        Native.SetWindowLong(hwnd, Native.GWL_STYLE, style & ~(Native.WS_SYSMENU | Native.WS_MINIMIZEBOX | Native.WS_MAXIMIZEBOX));

        Native.SetDwm(hwnd, Native.DWMWA_USE_IMMERSIVE_DARK_MODE, 1);
        Native.SetDwm(hwnd, Native.DWMWA_WINDOW_CORNER_PREFERENCE, Native.DWMWCP_ROUND);
        // Our own rim is drawn in WPF; DWM's would double it.
        Native.SetDwm(hwnd, Native.DWMWA_BORDER_COLOR, Native.DWMWA_COLOR_NONE);
        // The app asked for reduced motion: no zoom-and-fade from Windows either (it follows "Animation effects" itself).
        if (job.ReducedMotion) Native.SetDwm(hwnd, Native.DWMWA_TRANSITIONS_FORCEDISABLED, 1);
        // Acrylic needs Windows 11 22H2 (build 22621); before that the attribute is refused and the solid colour stays.
        bool acrylic = Environment.OSVersion.Version.Build >= 22621
            && Native.SetDwm(hwnd, Native.DWMWA_SYSTEMBACKDROP_TYPE, Native.DWMSBT_TRANSIENTWINDOW) == 0;
        if (acrylic)
        {
            // A dark tint over the acrylic keeps the dashboard's near-black and the text's contrast whatever is behind.
            Surface.Background = Frozen(Color.FromArgb(0xDE, 0x0F, 0x0F, 0x12));
            Resources["TrackBrush"] = Frozen(Color.FromArgb(0x14, 0xFF, 0xFF, 0xFF));
        }
        Place();
    }

    /// <summary>
    /// The popup opens without taking focus, and Windows draws an inactive window's backdrop as flat grey. Telling
    /// the frame it is always active keeps the acrylic (it changes how the frame is drawn, not which window has focus).
    /// </summary>
    IntPtr KeepFrameActive(IntPtr window, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != Native.WM_NCACTIVATE) return IntPtr.Zero;
        handled = true;
        return Native.DefWindowProc(window, msg, new IntPtr(1), new IntPtr(-1));
    }

    /// <summary>Centres the popup over the app's window (physical pixels from the job), else on the primary work area.</summary>
    void Place()
    {
        if (hwnd == IntPtr.Zero) return;
        int cx = 0, cy = 0;
        bool primary = job.Window is null;
        if (job.Window is { } w)
        {
            cx = w.X + w.Width / 2;
            cy = w.Y + w.Height / 2;
        }
        var (work, scale) = Native.MonitorAt(cx, cy, primary);
        if (primary)
        {
            cx = (work.Left + work.Right) / 2;
            cy = (work.Top + work.Bottom) / 2;
        }
        int width = (int)Math.Round(Width * scale), height = (int)Math.Round(Height * scale);
        int x = Math.Max(work.Left, Math.Min(cx - width / 2, work.Right - width));
        int y = Math.Max(work.Top, Math.Min(cy - height / 2, work.Bottom - height));
        // Position only: if this lands on a monitor with another DPI, WPF resizes the window and DpiChanged re-centres.
        Native.SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, Native.SWP_NOSIZE | Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
    }

    void OnLoaded(object sender, RoutedEventArgs e)
    {
        SetIndeterminate();
        if (!motion) return;
        // Breathing: 1 → 1.015 → 1 over 4.5 s.
        var breathe = new DoubleAnimation(1, 1.015, TimeSpan.FromSeconds(2.25))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        };
        FaceScale.BeginAnimation(ScaleTransform.ScaleXProperty, breathe);
        FaceScale.BeginAnimation(ScaleTransform.ScaleYProperty, breathe);
        Surface.Opacity = 0;
        Surface.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(160)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } });
    }

    // ---- Progress ------------------------------------------------------------------------------------------------

    internal void SetStep(string text)
    {
        if (StepText.Text == text) return;
        StepText.Text = text;
        Announce(StepText);
    }

    /// <summary>Moves the bar toward pct (0–100) over ~400 ms. It never moves backward.</summary>
    internal void SetProgress(double pct)
    {
        pct = Math.Max(0, Math.Min(100, pct));
        if (indeterminate)
        {
            indeterminate = false;
            StopShimmer();
            Taskbar.ProgressState = TaskbarItemProgressState.Normal;
            OnShownProgress(ShownProgress);
        }
        if (pct <= target) return;
        target = pct;
        if (motion)
            BeginAnimation(ShownProgressProperty, new DoubleAnimation(pct, TimeSpan.FromMilliseconds(400)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } });
        else
        {
            BeginAnimation(ShownProgressProperty, null);
            ShownProgress = pct;
        }
    }

    /// <summary>Windows hasn't said how far it is: the shimmer runs and the percentage hides.</summary>
    internal void SetIndeterminate()
    {
        indeterminate = true;
        PercentText.Text = "";
        Taskbar.ProgressState = TaskbarItemProgressState.Indeterminate;
        StartShimmer();
    }

    void OnShownProgress(double value)
    {
        Bar.Value = value;
        if (!indeterminate) PercentText.Text = $"{(int)Math.Floor(value)}%";
        Taskbar.ProgressValue = value / 100;
    }

    void OnTrackResized()
    {
        double w = TrackHost.ActualWidth, h = TrackHost.ActualHeight;
        TrackHost.Clip = new RectangleGeometry(new Rect(0, 0, w, h), 2, 2);
        if (indeterminate) StartShimmer();
    }

    void StartShimmer()
    {
        double width = TrackHost.ActualWidth;
        ShimmerHost.Visibility = Visibility.Visible;
        shimmer?.Stop(this);
        shimmer = null;
        if (width <= 0) return; // starts again once the track has its size
        if (!motion)
        {
            // Still a visible "working" track, without movement.
            Shimmer.Width = width;
            Shimmer.Opacity = 0.35;
            ShimmerShift.X = 0;
            return;
        }
        double band = Math.Round(width * 0.4);
        Shimmer.Width = band;
        Shimmer.Opacity = 1;
        var sweep = new DoubleAnimation(-band, width, TimeSpan.FromSeconds(1.4))
        {
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseInOut },
        };
        Storyboard.SetTarget(sweep, Shimmer);
        Storyboard.SetTargetProperty(sweep, new PropertyPath("RenderTransform.X"));
        shimmer = new Storyboard();
        shimmer.Children.Add(sweep);
        shimmer.Begin(this, true);
    }

    void StopShimmer()
    {
        shimmer?.Stop(this);
        shimmer = null;
        ShimmerHost.Visibility = Visibility.Collapsed;
    }

    // ---- Message states ------------------------------------------------------------------------------------------

    /// <summary>Swaps the bar for a short message (and buttons when given).</summary>
    internal void ShowMessage(string title, bool danger, string message, string? note, TaskbarItemProgressState taskbar, params PopupButton[] buttons)
    {
        StopShimmer();
        TitleText.Text = title;
        TitleText.Foreground = Frozen(danger ? Danger : TextPrimary);
        MessageText.Text = message;
        MessageText.ToolTip = message.Length > 90 ? message : null;
        NoteText.Text = note ?? "";
        NoteText.Visibility = string.IsNullOrEmpty(note) ? Visibility.Collapsed : Visibility.Visible;

        Buttons.Children.Clear();
        foreach (var b in buttons)
        {
            var button = new Button { Content = b.Label, Style = (Style)FindResource(b.Primary ? "PrimaryButton" : "SecondaryButton"), IsDefault = b.Primary };
            AutomationProperties.SetName(button, b.Label);
            button.Click += (_, _) => b.Run();
            Buttons.Children.Add(button);
        }
        Buttons.Visibility = buttons.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (buttons.Length > 0 && Buttons.Children[0] is FrameworkElement first) first.Margin = new Thickness(0);

        ProgressPanel.Visibility = Visibility.Collapsed;
        MessagePanel.Visibility = Visibility.Visible;
        if (motion)
            MessagePanel.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180)));
        Taskbar.ProgressState = taskbar;
        if (taskbar != TaskbarItemProgressState.None) Taskbar.ProgressValue = 1;
        AutomationProperties.SetName(this, $"{title}. {message}");
        Announce(MessageText);
    }

    // ---- Closing -------------------------------------------------------------------------------------------------

    /// <summary>Lets the window close without the fade, when the process has to end (the hard cap, a crash).</summary>
    internal void AllowClose() => allowClose = true;

    /// <summary>Fades out (200 ms, unless motion is reduced) and closes.</summary>
    internal async Task CloseAsync()
    {
        allowClose = true;
        if (motion && IsVisible)
        {
            var fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(200)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn } };
            var done = new TaskCompletionSource<bool>();
            fade.Completed += (_, _) => done.TrySetResult(true);
            Surface.BeginAnimation(OpacityProperty, fade);
            await Task.WhenAny(done.Task, Task.Delay(400));
        }
        Close();
    }

    // ---- Helpers -------------------------------------------------------------------------------------------------

    static void Announce(UIElement element)
    {
        var peer = UIElementAutomationPeer.FromElement(element) ?? UIElementAutomationPeer.CreatePeerForElement(element);
        peer?.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged);
    }

    /// <summary>Chief's face from the hand-off PNG; else the app icon embedded in this exe.</summary>
    ImageSource LoadFace()
    {
        if (job.FacePng is { } path && File.Exists(path))
        {
            try
            {
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad; // don't keep the file open
                image.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
                image.UriSource = new Uri(path, UriKind.Absolute);
                image.EndInit();
                image.Freeze();
                return image;
            }
            catch (Exception)
            {
                // a broken PNG: fall through to the icon
            }
        }
        var icon = new IconBitmapDecoder(new Uri("pack://application:,,,/ChiefUpdater.ico"), BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
        return icon.Frames.OrderByDescending(f => f.PixelWidth).First();
    }

    static Color? ParseColor(string text)
    {
        try { return ColorConverter.ConvertFromString(text.Trim()) is Color c ? Color.FromRgb(c.R, c.G, c.B) : null; }
        catch (FormatException) { return null; }
    }

    static double Luminance(Color c)
    {
        static double Channel(byte v)
        {
            double s = v / 255.0;
            return s <= 0.03928 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * Channel(c.R) + 0.7152 * Channel(c.G) + 0.0722 * Channel(c.B);
    }

    /// <summary>A segment of Chief's colour with soft ends and a lighter middle, like Windows' own indeterminate bar.</summary>
    static Brush ShimmerBrush(Color accent)
    {
        static byte Lift(byte v) => (byte)(v + (255 - v) * 0.3);
        var light = Color.FromRgb(Lift(accent.R), Lift(accent.G), Lift(accent.B));
        var brush = new LinearGradientBrush { StartPoint = new Point(0, 0.5), EndPoint = new Point(1, 0.5) };
        brush.GradientStops.Add(new GradientStop(Color.FromArgb(0, accent.R, accent.G, accent.B), 0));
        brush.GradientStops.Add(new GradientStop(accent, 0.3));
        brush.GradientStops.Add(new GradientStop(light, 0.5));
        brush.GradientStops.Add(new GradientStop(accent, 0.7));
        brush.GradientStops.Add(new GradientStop(Color.FromArgb(0, accent.R, accent.G, accent.B), 1));
        brush.Freeze();
        return brush;
    }

    static SolidColorBrush Frozen(Color c)
    {
        var brush = new SolidColorBrush(c);
        brush.Freeze();
        return brush;
    }
}
