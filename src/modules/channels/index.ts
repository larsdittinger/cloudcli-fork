export { default as InboxButton } from '@/modules/channels/inbox/InboxButton';
// InboxLinkOverlay: mounted by the workspace shell so `?inbox=<id>` links (held-message notifications) open that message.
export { default as InboxLinkOverlay } from '@/modules/channels/inbox/InboxLinkOverlay';
export { default as ChatChannelPanel } from '@/modules/channels/chat/ChatChannelPanel';
export { default as PendingReplyCard } from '@/modules/channels/chat/PendingReplyCard';
export { ChannelIcon, channelName, AccountStatusBadge, FIELD_CLASS, formatWhen } from '@/modules/channels/ChannelBits';
export { useChannelsEvents } from '@/modules/channels/hooks/useChannelsEvents';
export type {
  AccountStatus,
  AgentSendMode,
  ChannelAccount,
  ChannelMessage,
  ChannelRule,
  ChannelRuleInput,
  ChannelType,
  ChannelsSummary,
  ConversationMode,
  OutboxItem,
  PermissionMode,
  ReplyMode,
  ReplyScope,
  RuleConditions,
} from '@/modules/channels/types';
