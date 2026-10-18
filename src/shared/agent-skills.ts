// Product shortcuts and the exact allowlist loaded by the main process.
export const agentSkills = [
  {
    name: 'concert-video-archive',
    command: '/concert',
    title: '演唱会录像归档',
    description: '检查录像、压缩备份，按标签找回'
  },
  {
    name: 'wechat-file-archive',
    command: '/wechat',
    title: '微信文件归档',
    description: '整理文件和视频，保留独立图片'
  },
  {
    name: 'lightroom-photo-archive',
    command: '/photos',
    title: 'Lightroom 照片归档',
    description: '压缩导出照片，保留原件并按活动找回'
  }
] as const

export function expandSkillShortcut(text: string): string {
  const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const skill = agentSkills.find(
    (item) => item.command === match?.[1] || `/skill:${item.name}` === match?.[1]
  )
  return skill ? `/skill:${skill.name}${match?.[2] ? ` ${match[2]}` : ''}` : text
}
