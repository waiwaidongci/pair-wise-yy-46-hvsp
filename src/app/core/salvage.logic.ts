import type { ClaimCase } from './models'
import type { AllocationLedger, AllocationRecord, ItemLedger, SalvageBatch } from './salvage.models'

export const MIXED = 'MIXED'

export function now(): string {
  return new Date().toLocaleString('zh-CN')
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

// 参与分摊的有效批次：已复核、未退回、未失效、已冲减
function activeBatches(claim: ClaimCase, batches: SalvageBatch[]): SalvageBatch[] {
  return batches.filter(
    (b) =>
      b.claimId === claim.id &&
      b.reviewStatus === '已复核' &&
      b.status !== '已退回' &&
      !b.invalid &&
      b.status !== '已失效' &&
      b.offsetAmount > 0,
  )
}

// 混卖批次按各科目预估残值比例分摊
function mixedShare(claim: ClaimCase, itemId: string, amount: number): number {
  const totalSalvage = claim.lossItems.reduce((sum, it) => sum + (it.salvage > 0 ? it.salvage : 0), 0)
  if (totalSalvage <= 0) return 0
  const item = claim.lossItems.find((it) => it.id === itemId)
  if (!item || item.salvage <= 0) return 0
  return Math.round((amount * item.salvage) / totalSalvage)
}

// 由有效批次推导分摊分录（分摊账）
export function computeAllocations(claim: ClaimCase, batches: SalvageBatch[]): AllocationRecord[] {
  const records: AllocationRecord[] = []
  for (const batch of activeBatches(claim, batches)) {
    if (batch.sourceItemId === MIXED) {
      for (const item of claim.lossItems) {
        if (item.salvage <= 0) continue
        const amount = mixedShare(claim, item.id, batch.offsetAmount)
        if (amount <= 0) continue
        records.push({
          id: uid('AL'),
          claimId: claim.id,
          batchId: batch.id,
          itemId: item.id,
          category: item.category,
          amount,
          version: batch.version,
          basis: batch.basis,
          allocatedAt: now(),
          invalid: false,
        })
      }
    } else {
      const item = claim.lossItems.find((it) => it.id === batch.sourceItemId)
      if (!item) continue
      records.push({
        id: uid('AL'),
        claimId: claim.id,
        batchId: batch.id,
        itemId: item.id,
        category: item.category,
        amount: batch.offsetAmount,
        version: batch.version,
        basis: batch.basis,
        allocatedAt: now(),
        invalid: false,
      })
    }
  }
  return records
}

// 构建科目分摊对照与总账
export function buildLedger(claim: ClaimCase, batches: SalvageBatch[]): AllocationLedger {
  const claimBatches = batches.filter((b) => b.claimId === claim.id)
  const perItem: ItemLedger[] = claim.lossItems.map((item) => {
    const allocated = activeBatches(claim, claimBatches).reduce((sum, b) => {
      if (b.sourceItemId === MIXED) return sum + mixedShare(claim, item.id, b.offsetAmount)
      return sum + (b.sourceItemId === item.id ? b.offsetAmount : 0)
    }, 0)
    return {
      itemId: item.id,
      category: item.category,
      description: item.description,
      estimated: item.salvage,
      allocated,
      variance: item.salvage - allocated,
    }
  })

  const estimatedSalvage = perItem.reduce((sum, it) => sum + it.estimated, 0)
  const recovered = perItem.reduce((sum, it) => sum + it.allocated, 0)
  const pendingReview = claimBatches.filter((b) => b.reviewStatus === '待复核').reduce((sum, b) => sum + b.dealAmount, 0)
  const invalidAmount = claimBatches
    .filter((b) => b.invalid || b.status === '已失效')
    .reduce((sum, b) => sum + b.offsetAmount, 0)
  const returnedAmount = claimBatches.filter((b) => b.status === '已退回').reduce((sum, b) => sum + b.dealAmount, 0)
  const variance = estimatedSalvage - recovered

  return {
    claimId: claim.id,
    estimatedSalvage,
    recovered,
    pendingReview,
    invalidAmount,
    returnedAmount,
    variance,
    coverageRatio: estimatedSalvage > 0 ? recovered / estimatedSalvage : 0,
    perItem,
  }
}

// 冲减前校验：未复核 / 已退回 / 已失效 / 冲突留持 均不能冲减
export function validateOffset(batch: SalvageBatch): string | null {
  if (batch.held) return '该批次为冲突留持，待裁决后才能冲减'
  if (batch.reviewStatus === '待复核') return '未复核批次不能冲减'
  if (batch.status === '已退回') return '残值已退回，不能冲减'
  if (batch.invalid || batch.status === '已失效') return '分摊已失效，请重算后再冲减'
  if (batch.status === '已冲减') return '批次已完成冲减'
  return null
}

// 放行校验：存在失效待重算或待裁决冲突时不能放行
export function releaseBlockers(claimId: string, batches: SalvageBatch[], conflicts: Array<{ claimId: string; status: string }>): string[] {
  const blockers: string[] = []
  const claimBatches = batches.filter((b) => b.claimId === claimId)
  if (claimBatches.some((b) => b.invalid || b.status === '已失效')) {
    blockers.push('存在已失效的分摊，需重算后才能放行')
  }
  if (conflicts.some((c) => c.claimId === claimId && c.status === '待裁决')) {
    blockers.push('存在待裁决的批次金额冲突，需先处理')
  }
  return blockers
}
