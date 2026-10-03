import type { AllocationEntry, BatchConflict, SalvageBatch, SalvageLine } from './models'
import type { ClaimCase, LossItem } from '../core/models'

/** 分摊失败：如来源科目残值合计为 0，无法按残值占比分摊成交额 */
export class AllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationError'
  }
}

export const latestQuote = (item: LossItem): { version: number; amount: number } => {
  const quote = item.repairQuotes.at(-1)
  return quote ? { version: quote.version, amount: quote.amount } : { version: 0, amount: 0 }
}

export const liveItem = (claim: ClaimCase, itemId: string): LossItem | undefined =>
  claim.lossItems.find((item) => item.id === itemId)

/** 批次行的当前残值估值合计（旧案补录与常规分摊的统一权重口径） */
export const totalSalvageWeight = (lines: Array<{ salvageEstimate: number }>) =>
  lines.reduce((sum, line) => sum + line.salvageEstimate, 0)

/** 依据变化原因：成交价更正 / 残值退回 / 科目报价变化 */
export type StaleReason =
  | { kind: 'deal'; detail: string }
  | { kind: 'return'; detail: string }
  | { kind: 'quote'; detail: string }

export function entryStaleReasons(
  entry: AllocationEntry,
  batch: SalvageBatch,
  claim: ClaimCase | undefined,
): StaleReason[] {
  const reasons: StaleReason[] = []
  if (entry.basisDealAmount !== batch.dealAmount) {
    reasons.push({ kind: 'deal', detail: `成交价由 ${entry.basisDealAmount.toLocaleString('zh-CN')} 更正为 ${batch.dealAmount.toLocaleString('zh-CN')}` })
  }
  if (entry.basisReturnedAmount !== batch.returnedAmount) {
    reasons.push({ kind: 'return', detail: `残值退回 ${(batch.returnedAmount - entry.basisReturnedAmount).toLocaleString('zh-CN')} 元` })
  }
  const item = claim?.lossItems.find((loss) => loss.id === entry.itemId)
  if (item) {
    const quote = latestQuote(item)
    if (entry.basisQuoteVersion !== quote.version) {
      reasons.push({ kind: 'quote', detail: `${entry.category}报价由 V${entry.basisQuoteVersion} 更新为 V${quote.version}` })
    }
  }
  return reasons
}

export function batchStaleReasons(batch: SalvageBatch, claim: ClaimCase | undefined): StaleReason[] {
  const current = batch.entries
  if (current.length === 0) return []
  return current.flatMap((entry) => entryStaleReasons(entry, batch, claim))
}

export type EntryStatus = '生效中' | '待复核' | '已失效'

export function entryStatus(
  entry: AllocationEntry,
  batch: SalvageBatch,
  claim: ClaimCase | undefined,
): EntryStatus {
  if (!batch.reviewedBy || batch.reviewStale) return '待复核'
  return entryStaleReasons(entry, batch, claim).length > 0 ? '已失效' : '生效中'
}

export type DerivedBatch = SalvageBatch & {
  staleReasons: StaleReason[]
  isStale: boolean
  effectiveAmount: number
  pendingAmount: number
  activeConflict: boolean
  blockerLabel: string | null
}

export function deriveBatch(batch: SalvageBatch, claim: ClaimCase | undefined): DerivedBatch {
  const reasons = batchStaleReasons(batch, claim)
  const reviewed = !!batch.reviewedBy && !batch.reviewStale
  const isStale = reasons.length > 0
  const effectiveAmount =
    reviewed && !isStale
      ? Math.max(0, batch.dealAmount - batch.returnedAmount)
      : 0
  const pendingAmount =
    !reviewed || isStale ? Math.max(0, batch.dealAmount - batch.returnedAmount) : 0
  const activeConflict = batch.conflicts.some((conflict) => !conflict.resolvedBy)
  let blockerLabel: string | null = null
  if (activeConflict) blockerLabel = '存在未处理的并发冲突金额'
  else if (!batch.reviewedBy) blockerLabel = '残值批次尚未复核，回收款不能冲减'
  else if (batch.reviewStale) blockerLabel = '成交价更正/残值退回后需复核确认'
  else if (isStale) blockerLabel = '分摊依据已变化，原冲减失效需重算'
  return { ...batch, staleReasons: reasons, isStale, effectiveAmount, pendingAmount, activeConflict, blockerLabel }
}

/** 金额取整（元），尾差并入权重最大的科目，保证分配合计 = 可分摊成交额 */
function roundShare(values: number[]): number[] {
  const floors = values.map((value) => Math.floor(value))
  const remainder = values.reduce((sum, value) => sum + value, 0) - floors.reduce((sum, value) => sum + value, 0)
  let units = Math.round(remainder)
  const order = values
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)
  let cursor = 0
  while (units > 0 && order.length > 0) {
    floors[order[cursor % order.length].index] += 1
    units -= 1
    cursor += 1
  }
  return floors
}

/** 按来源科目残值占比分摊成交额；残值合计为 0 无法分摊 */
export function allocate(
  lines: SalvageLine[],
  dealAmount: number,
  returnedAmount: number,
  version: number,
  existing: AllocationEntry[] = [],
): AllocationEntry[] {
  if (lines.length === 0) throw new AllocationError('批次未选择任何来源科目，缺少分摊依据')
  const weightTotal = totalSalvageWeight(lines)
  if (weightTotal <= 0) {
    throw new AllocationError('来源科目残值合计为 0，无法按残值占比分摊成交额')
  }
  const distributable = Math.max(0, dealAmount - returnedAmount)
  const raw = lines.map((line) => (distributable * line.salvageEstimate) / weightTotal)
  const shares = roundShare(raw)
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  return lines.map((line, index) => {
    const previous = existing.find((entry) => entry.itemId === line.itemId)
    return {
      id: previous?.id ?? `AL-${line.itemId}-${version}`,
      version,
      itemId: line.itemId,
      category: line.category,
      weight: line.salvageEstimate / weightTotal,
      allocatedAmount: shares[index],
      basisDealAmount: dealAmount,
      basisReturnedAmount: returnedAmount,
      basisQuoteVersion: line.quoteVersion,
      computedAt: now,
      planLabels: previous?.planLabels ?? [],
    }
  })
}

export type EffectiveItemDeduction = {
  itemId: string
  category: string
  amount: number
}

/** 当前真正可冲减的科目金额：仅生效中分录（已复核 + 依据未变） */
export function effectiveDeductions(
  batches: SalvageBatch[],
  claim: ClaimCase | undefined,
): EffectiveItemDeduction[] {
  const map = new Map<string, { category: string; amount: number }>()
  for (const batch of batches) {
    const derived = deriveBatch(batch, claim)
    if (derived.blockerLabel) continue
    for (const entry of batch.entries) {
      const slot = map.get(entry.itemId) ?? { category: entry.category, amount: 0 }
      slot.amount += entry.allocatedAmount
      map.set(entry.itemId, slot)
    }
  }
  return [...map.entries()].map(([itemId, value]) => ({ itemId, category: value.category, amount: value.amount }))
}

export type PlanViewRow = {
  itemId: string
  category: string
  quoteAmount: number
  salvageDeduction: number
  liability: number
  disputed: boolean
  contributionA: number
  contributionB: number
}

export type PlanView = {
  rows: PlanViewRow[]
  grossBeforeSalvage: number
  totalDeduction: number
  planA: number
  planB: number
}

const DISPUTED_HOLDBACK_PER_ITEM = 72000

/** 赔付方案试算：净额 = Σ(最新报价 − 生效残值冲减) × 责任比例 − 免赔额 */
export function buildPlanView(batches: SalvageBatch[], claim: ClaimCase): PlanView {
  const deductions = effectiveDeductions(batches, claim)
  const rows: PlanViewRow[] = claim.lossItems.map((item) => {
    const { amount: quoteAmount } = latestQuote(item)
    const salvageDeduction = deductions.find((deduction) => deduction.itemId === item.id)?.amount ?? 0
    const contributionA = Math.max(0, quoteAmount - salvageDeduction) * item.liability
    const contributionB = contributionA - (item.disputed ? DISPUTED_HOLDBACK_PER_ITEM * item.liability : 0)
    return {
      itemId: item.id,
      category: item.category,
      quoteAmount,
      salvageDeduction,
      liability: item.liability,
      disputed: item.disputed,
      contributionA,
      contributionB: Math.max(0, contributionB),
    }
  })
  const grossBeforeSalvage = claim.lossItems.reduce((sum, item) => sum + latestQuote(item).amount, 0)
  const totalDeduction = deductions.reduce((sum, deduction) => sum + deduction.amount, 0)
  return {
    rows,
    grossBeforeSalvage,
    totalDeduction,
    planA: Math.max(0, rows.reduce((sum, row) => sum + row.contributionA, 0) - claim.deductible),
    planB: Math.max(0, rows.reduce((sum, row) => sum + row.contributionB, 0) - claim.deductible),
  }
}

/** 方案放行阻断项：未复核 / 已失效 / 待复核确认 / 并发冲突 */
export function releaseBlockers(batches: SalvageBatch[], claim: ClaimCase): string[] {
  const blockers: string[] = []
  for (const batch of batches) {
    const derived = deriveBatch(batch, claim)
    if (derived.blockerLabel) blockers.push(`${batch.batchNo}：${derived.blockerLabel}`)
  }
  const hasSalvageEstimate = claim.lossItems.some((item) => item.salvage > 0)
  if (batches.length === 0 && hasSalvageEstimate) {
    blockers.push('旧案件缺少残值分摊依据，需按残值补录一版后方可放行')
  }
  return blockers
}

export function unresolvedConflict(batch: SalvageBatch): BatchConflict | undefined {
  return batch.conflicts.find((conflict) => !conflict.resolvedBy)
}
