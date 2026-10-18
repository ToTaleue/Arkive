import { app } from 'electron'
import { join } from 'node:path'
import type { LoadSkillsResult } from '@earendil-works/pi-coding-agent'
import { agentSkills } from '../../../shared/agent-skills'

export async function loadBuiltInSkills(cwd: string): Promise<LoadSkillsResult> {
  const { loadSkills } = await import('@earendil-works/pi-coding-agent')
  const result = loadSkills({
    cwd,
    agentDir: cwd,
    includeDefaults: false,
    skillPaths: agentSkills.map((skill) =>
      join(app.getAppPath(), 'resources', 'skills', skill.name, 'SKILL.md')
    )
  })
  if (
    result.diagnostics.length ||
    result.skills.length !== agentSkills.length ||
    agentSkills.some((entry) => !result.skills.some((skill) => skill.name === entry.name))
  )
    throw new Error('内置场景 Skill 加载失败，请检查应用资源是否完整。')
  return result
}
