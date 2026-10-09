import type { SVGProps } from "react"
import {
  ArrowLeft,
  Bell,
  BellOff,
  ChevronRight,
  CircleHelp,
  Contact,
  Copy,
  FolderOpen,
  Globe,
  Info,
  ListFilter,
  MessagesSquare,
  Palette,
  Paperclip,
  Plus,
  Reply,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Star,
  Ticket,
  Trash2,
  UsersRound,
  X,
  type LucideProps,
} from "lucide-react"

const icons = {
  search: Search,
  messages: MessagesSquare,
  group: UsersRound,
  plus: Plus,
  invite: Ticket,
  people: Contact,
  files: FolderOpen,
  help: CircleHelp,
  settings: Settings,
  bell: Bell,
  bellOff: BellOff,
  attach: Paperclip,
  send: SendHorizontal,
  details: Info,
  star: Star,
  copy: Copy,
  trash: Trash2,
  reply: Reply,
  close: X,
  filter: ListFilter,
  chevron: ChevronRight,
  back: ArrowLeft,
  shield: ShieldCheck,
  connection: Globe,
  appearance: Palette,
} as const

export type IconName = keyof typeof icons

export function Icon({ name, size = 18, ...props }: { name: IconName | string; size?: number } & SVGProps<SVGSVGElement> & LucideProps) {
  const Component = (icons as Record<string, typeof Search>)[name] ?? Info
  return <Component className={`icon ${props.className ?? ""}`} size={size} strokeWidth={2} aria-hidden="true" focusable="false" {...props} />
}
