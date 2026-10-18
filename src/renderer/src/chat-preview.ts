// In-memory UI data; seeded examples are read-only and never sent to Pi.
import type { AgentExecution } from '../../shared/contracts/agent'

export type PreviewMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  execution?: AgentExecution
  sourceRequestId?: string
}
export type Conversation = {
  id: string
  title: string
  example: boolean
  messages: PreviewMessage[]
}

export const initialConversations: Conversation[] = [
  { id: 'welcome', title: '新对话', example: false, messages: [] },
  {
    id: 'video-example',
    title: '整理一批旧视频',
    example: true,
    messages: [
      {
        id: 'video-user',
        role: 'user',
        content: '我有一些很久没看的视频，想压小一点，但保留原件。'
      },
      {
        id: 'video-assistant',
        role: 'assistant',
        content:
          '可以先从一小批视频开始，比较压缩前后的效果，再决定是否批量处理。\n\n我们可以一起确认：\n\n01  需要整理哪些视频\n02  更在意画质，还是节省空间\n03  压缩后的文件放在哪里\n\n原件会保留，压缩结果需要先校验。\n\n这是示例对话，尚未读取或处理任何文件。'
      }
    ]
  },
  {
    id: 'archive-example',
    title: '给旧资料找一个家',
    example: true,
    messages: [
      { id: 'archive-user', role: 'user', content: '我想把以前的项目资料归档起来，以后还方便找。' },
      {
        id: 'archive-assistant',
        role: 'assistant',
        content:
          '可以按项目整理，并保留清晰的名称和时间信息。\n\n先告诉我这些资料大致是什么类型，以及你平时会怎样查找它们。我们再一起确定归档方式。\n\n这是示例对话，尚未建立真实归档。'
      }
    ]
  }
]
