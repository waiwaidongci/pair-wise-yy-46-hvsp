import type { ClaimCase } from './models'

// 残值批次状态
export type BatchStatus = '待复核' | '已复核' | '已冲减' | '已退回' | '已失效'
export type ReviewStatus = '待复核' | '已复核'
export type ConflictStatus = '待裁决' | '已确认' | '已驳回'

// 残值批次：记录来源科目、成交额、复核人
export type SalvageBatch = {
  id: string
  claimId: string
  sourceItemId: string // 损失科目 id；MIXED 表示混卖
  sourceCategory: string // 来源科目名称，混卖时为「混卖」
  dealAmount: number // 成交额
  reviewer: string // 复核人
  reviewStatus: ReviewStatus // 未复核不能冲减
  submittedBy: string // 经办人
  submittedAt: string
  status: BatchStatus
  version: number // 分摊依据版本号
  basis: string // 分摊依据
  invalid: boolean // 原分摊是否已失效
  invalidReason: string
  offsetAmount: number // 已冲减金额
  held: boolean // 后到金额留作冲突，暂不放行
}

// 分摊记录（由批次按规则推导，构成分摊账分录）
export type AllocationRecord = {
  id: string
  claimId: string
  batchId: string
  itemId: string
  category: string
  amount: number
  version: number
  basis: string
  allocatedAt: string
  invalid: boolean
}

// 并发冲突：两名经办提交同一批次，先到者生效，后到金额留作冲突
export type BatchConflict = {
  id: string
  claimId: string
  winnerBatchId: string
  loserBatchId: string
  sourceCategory: string
  amount: number // 后到金额
  submittedBy: string
  submittedAt: string
  status: ConflictStatus
}

// 本地批次草稿：分摊失败后保留，可恢复
export type LocalBatchDraft = {
  id: string
  claimId: string
  sourceItemId: string
  sourceCategory: string
  dealAmount: number
  basis: string
  submittedBy: string
  savedAt: string
  reason: string // 失败原因
}

// 科目分摊对照
export type ItemLedger = {
  itemId: string
  category: string
  description: string
  estimated: number // 预估残值
  allocated: number // 已分摊回收
  variance: number // 差异 = 预估 - 已分摊
}

// 分摊账
export type AllocationLedger = {
  claimId: string
  estimatedSalvage: number // 预估残值合计
  recovered: number // 已回收（有效已冲减）
  pendingReview: number // 待复核金额
  invalidAmount: number // 失效待重算金额
  returnedAmount: number // 残值退回金额
  variance: number // 回收款与赔付方案差异
  coverageRatio: number // 残值覆盖率
  perItem: ItemLedger[]
}

export type { ClaimCase }
