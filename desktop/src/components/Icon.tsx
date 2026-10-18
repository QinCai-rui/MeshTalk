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

export function Icon({ name, size = 18, className, ...props }: { name: IconName; size?: number } & SVGProps<SVGSVGElement> & LucideProps) {
  const Component = icons[name]
  return <Component size={size} strokeWidth={2} aria-hidden="true" focusable="false" {...props} className={`icon ${className ?? ""}`.trim()} />
}
