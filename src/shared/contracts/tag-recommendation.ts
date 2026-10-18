/** Already collected, flattened metadata; this API does not read files. */
export type TagMetadataValue = string | number | boolean | null | string[]

export interface TagRecommendationFile {
  fileId: string
  fileName: string
  /** The original location, never an automatically generated archive/backup path. */
  originalPath?: string
  metadata?: Record<string, TagMetadataValue>
  existingTags?: string[]
}

export interface TagRecommendationInput {
  files: TagRecommendationFile[]
  /** User vocabulary in addition to the built-in presets and each file's tags. */
  availableTags?: string[]
  /** Relevant user-authored context supplied explicitly by the caller. */
  userContext?: string
  /** Oldest first; each correction applies only to its listed files in this batch. */
  corrections?: { fileIds: string[]; instruction: string }[]
}

export interface RecommendedTag {
  name: string
  reason: string
  /** Computed by Arkive against the supplied vocabulary, not trusted to the model. */
  isNew: boolean
}

export interface TagRecommendationItem {
  fileId: string
  tags: RecommendedTag[]
}

export type TagRecommendationResult =
  | { status: 'completed'; items: TagRecommendationItem[] }
  | { status: 'cancelled' }
  | { status: 'error'; error: string }
