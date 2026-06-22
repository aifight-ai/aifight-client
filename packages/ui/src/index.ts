// @aifight/ui — public surface.
//
// Shared presentational React components used by BOTH the website (web/) and the
// desktop client (desktop/): agent avatars, the avatar picker, and the replay /
// live game visuals. Anything imported by an app from this package is re-exported
// here. (SeatCard / BoardV2 are internal building blocks of the replay visuals and
// are intentionally not part of the public surface.)

export * from './components/AgentAvatar'
export * from './components/AvatarPicker'
export * from './components/replay/gameVisuals'
export * from './lib/agentVisual'
export * from './lib/identicon'
export * from './lib/avatarPresets'
