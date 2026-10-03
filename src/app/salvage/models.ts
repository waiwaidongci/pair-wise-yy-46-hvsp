// 残值分摊账领域模型：残值批次 -> 分摊分录 -> 赔付方案

export type BatchSourceTag = '常规混卖' | '按残值补录'

/** 批次来源科目行（提交时对科目残值与报价版本做快照） */
export type SalvageLine = {
  itemId: string
  category: string
  description: string
  salvageEstimate: number
  quoteVersion: number
  quoteAmount: number
}

/** 分摊分录：一笔混卖成交额按来源科目残值占比回拨到具体科目 */
export type AllocationEntry = {
  id: string
  version: number
  itemId: string
  category: string
  weight: number
  allocatedAmount: number
  // 分摊依据指纹：任一变化则该版分录失效
  basisDealAmount: number
  basisReturnedAmount: number
  basisQuoteVersion: number
  computedAt: string
  planLabels: string[]
}

/** 并发提交时后到者金额留作冲突 */
export type BatchConflict = {
  id: string
  operator: string
  dealAmount: number
  at: string
  note: string
  resolvedBy: string | null
  resolvedAt: string | null
  resolution: string | null
}

export type SalvageBatch = {
  id: string
  clientBatchId: string
  batchNo: string
  claimId: string
  lines: SalvageLine[]
  dealAmount: number
  returnedAmount: number
  sourceTag: BatchSourceTag
  submittedBy: string
  submittedAt: string
  reviewedBy: string | null
  reviewedAt: string | null
  /** 成交价更正 / 残值退回后需再次复核确认，期间分录不得冲减 */
  reviewStale: boolean
  entries: AllocationEntry[]
  entryHistory: AllocationEntry[]
  conflicts: BatchConflict[]
}

/** 分摊失败后保留在本地、可恢复的批次 */
export type LocalSalvageDraft = {
  id: string
  clientBatchId: string
  claimId: string
  operator: string
  itemIds: string[]
  dealAmount: number
  sourceTag: BatchSourceTag
  failureKind: '提交失败' | '分摊失败' | '并发冲突'
  reason: string
  at: string
}

export type LedgerEvent = {
  id: string
  at: string
  claimId: string
  operator: string
  action: string
  detail: string
}

export type PayoutPlanKind = 'A' | 'B'

export type ReleasedPlan = {
  at: string
  by: string
  amountSnapshot: number
}

// ---- 请求体 ----

export type SubmitBatchBody = {
  clientBatchId: string
  claimId: string
  itemIds: string[]
  dealAmount: number
  operator: string
  sourceTag?: BatchSourceTag
  simulateFail?: boolean
}

export type ReviewBody = { reviewer: string }
export type CorrectBody = { dealAmount: number; operator: string }
export type ReturnBody = { amount: number; operator: string }
export type ResolveConflictBody = { operator: string; resolution: string }
