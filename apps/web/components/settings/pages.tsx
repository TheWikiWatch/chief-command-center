import type { ReactNode } from "react";

import { AudioLinesIcon, BellIcon, WrenchIcon, BookOpenIcon, ChartColumnIcon, HardDriveDownloadIcon, InfoIcon, KeyRoundIcon, SlidersHorizontalIcon, SmartphoneIcon } from "@/components/icons";
import type { SettingsCategory } from "@/lib/settings-nav";

/**
 * The Settings pages: the panel's list, and the command palette's "Settings: …" entries (this module stays
 * small so the palette doesn't load the whole panel). `keywords` are other words that find a page.
 */
export const SETTINGS_PAGES: { id: SettingsCategory; label: string; blurb: string; keywords: string; icon: ReactNode; Icon: (p: { className?: string }) => ReactNode }[] = [
  { id: "general", label: "General", blurb: "Names, identity and how this app looks.", keywords: "name rename identity soul memory appearance text size motion", icon: <SlidersHorizontalIcon size={17} />, Icon: ({ className }) => <SlidersHorizontalIcon className={className} /> },
  { id: "models", label: "Models & keys", blurb: "The model the chief thinks with, and the providers your bots can use.", keywords: "provider api key openai anthropic model connection", icon: <KeyRoundIcon size={17} />, Icon: ({ className }) => <KeyRoundIcon className={className} /> },
  { id: "tools", label: "Tools", blurb: "Making images and searching the web: pick the services, add keys, try them.", keywords: "image generation picture openai dall-e gpt-image fal web search browse internet exa tavily brave perplexity", icon: <WrenchIcon size={17} />, Icon: ({ className }) => <WrenchIcon className={className} /> },
  { id: "voice", label: "Voice", blurb: "How the chief speaks and listens.", keywords: "speech tts stt microphone speak replies check my system", icon: <AudioLinesIcon size={17} />, Icon: ({ className }) => <AudioLinesIcon className={className} /> },
  { id: "second-brain", label: "Second Brain", blurb: "Your notes folder and its routines.", keywords: "vault obsidian notes folder routines morning nightly", icon: <BookOpenIcon size={17} />, Icon: ({ className }) => <BookOpenIcon className={className} /> },
  { id: "notifications", label: "Notifications", blurb: "Alerts, sounds and vibration on this device.", keywords: "sound haptics vibration alerts push", icon: <BellIcon size={17} />, Icon: ({ className }) => <BellIcon className={className} /> },
  { id: "phone", label: "Phone", blurb: "Use the app on your phone, privately, with alerts.", keywords: "tailscale mobile android iphone qr", icon: <SmartphoneIcon size={17} />, Icon: ({ className }) => <SmartphoneIcon className={className} /> },
  { id: "usage", label: "Usage", blurb: "Tokens and cost for the chief and every bot, and your budget.", keywords: "cost tokens budget spend money", icon: <ChartColumnIcon size={17} />, Icon: ({ className }) => <ChartColumnIcon className={className} /> },
  { id: "backup", label: "Backup & updates", blurb: "Copies of your setup, and new versions of the app.", keywords: "restore update version backup", icon: <HardDriveDownloadIcon size={17} />, Icon: ({ className }) => <HardDriveDownloadIcon className={className} /> },
  { id: "about", label: "About", blurb: "Versions, licences and credits.", keywords: "version licence credits hermes", icon: <InfoIcon size={17} />, Icon: ({ className }) => <InfoIcon className={className} /> },
];
