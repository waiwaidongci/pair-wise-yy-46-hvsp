import { createAction, createReducer, createSelector, on, props } from '@ngrx/store'
import type { AppState } from './claims.store'
import type { BatchConflict, LocalBatchDraft, SalvageBatch } from './salvage.models'
import { MIXED, now, uid } from './salvage.logic'

export type ClaimBucket = {
  batches: SalvageBatch[]
  conflicts: BatchConflict[]
  drafts: LocalBatchDraft[]
  recalcNeeded: boolean
  lastRecalcAt: string
  released: boolean
}

export type SalvageState = {
  byClaim: Record<string, ClaimBucket>
  activeClaimId: string
  toast: string
}

const emptyBucket = (): ClaimBucket => ({
  batches: [],
  conflicts: [],
  drafts: [],
  recalcNeeded: false,
  lastRecalcAt: '',
  released: false,
})

// 初始演示数据：CLM-2026-0918 含已冲减、待复核、已失效、冲突留持四种状态
const seedBatches: SalvageBatch[] = [
  {
    id: 'SB-001',
    claimId: 'CLM-2026-0918',
    sourceItemId: 'LI-02',
    sourceCategory: '机器设备',
    dealAmount: 30000,
    reviewer: '王复核',
    reviewStatus: '已复核',
    submittedBy: '陆嘉',
    submittedAt: '2026-09-19 09:10',
    status: '已冲减',
    version: 1,
    basis: '按设备回收商报价单',
    invalid: false,
    invalidReason: '',
    offsetAmount: 30000,
    held: false,
  },
  {
    id: 'SB-002',
    claimId: 'CLM-2026-0918',
    sourceItemId: MIXED,
    sourceCategory: '混卖',
    dealAmount: 20000,
    reviewer: '',
    reviewStatus: '待复核',
    submittedBy: '陆嘉',
    submittedAt: '2026-09-20 14:22',
    status: '待复核',
    version: 1,
    basis: '混卖一揽子回收，待按残值比例分摊',
    invalid: false,
    invalidReason: '',
    offsetAmount: 0,
    held: false,
  },
  {
    id: 'SB-003',
    claimId: 'CLM-2026-0918',
    sourceItemId: 'LI-01',
    sourceCategory: '房屋建筑',
    dealAmount: 15000,
    reviewer: '王复核',
    reviewStatus: '已复核',
    submittedBy: '陈立',
    submittedAt: '2026-09-18 17:05',
    status: '已失效',
    version: 1,
    basis: '按拆除回收报价',
    invalid: true,
    invalidReason: '房屋檩条报价调整，原分摊依据失效',
    offsetAmount: 15000,
    held: false,
  },
  {
    id: 'SB-004',
    claimId: 'CLM-2026-0918',
    sourceItemId: 'LI-01',
    sourceCategory: '房屋建筑',
    dealAmount: 11000,
    reviewer: '王复核',
    reviewStatus: '已复核',
    submittedBy: '周凯',
    submittedAt: '2026-09-20 10:00',
    status: '已冲减',
    version: 1,
    basis: '按现场残值回收单',
    invalid: false,
    invalidReason: '',
    offsetAmount: 11000,
    held: false,
  },
  {
    id: 'SB-005',
    claimId: 'CLM-2026-0918',
    sourceItemId: 'LI-01',
    sourceCategory: '房屋建筑',
    dealAmount: 11000,
    reviewer: '',
    reviewStatus: '待复核',
    submittedBy: '李娜',
    submittedAt: '2026-09-20 10:00',
    status: '待复核',
    version: 1,
    basis: '按现场残值回收单（后到）',
    invalid: false,
    invalidReason: '',
    offsetAmount: 0,
    held: true,
  },
]

const seedConflicts: BatchConflict[] = [
  {
    id: 'CF-001',
    claimId: 'CLM-2026-0918',
    winnerBatchId: 'SB-004',
    loserBatchId: 'SB-005',
    sourceCategory: '房屋建筑',
    amount: 11000,
    submittedBy: '李娜',
    submittedAt: '2026-09-20 10:00',
    status: '待裁决',
  },
]

const persisted = localStorage.getItem('property-claims-salvage-v1')

function initialState(): SalvageState {
  if (persisted) {
    try {
      return JSON.parse(persisted) as SalvageState
    } catch {
      // 损坏则回退到种子
    }
  }
  return {
    byClaim: {
      'CLM-2026-0918': {
        batches: seedBatches,
        conflicts: seedConflicts,
        drafts: [],
        recalcNeeded: true,
        lastRecalcAt: '',
        released: false,
      },
    },
    activeClaimId: 'CLM-2026-0918',
    toast: '',
  }
}

export const salvageInit = createAction('[Salvage] Init')
export const salvageSelectClaim = createAction('[Salvage] Select Claim', props<{ claimId: string }>())
export const salvageSubmitBatch = createAction(
  '[Salvage] Submit Batch',
  props<{
    claimId: string
    sourceItemId: string
    sourceCategory: string
    dealAmount: number
    basis: string
    submittedBy: string
    concurrent: boolean
  }>(),
)
export const salvageReviewBatch = createAction('[Salvage] Review Batch', props<{ batchId: string; reviewer: string }>())
export const salvageOffsetSuccess = createAction('[Salvage] Offset Success', props<{ batchId: string }>())
export const salvageOffsetFailure = createAction('[Salvage] Offset Failure', props<{ claimId: string; draft: LocalBatchDraft }>())
export const salvageCorrectPrice = createAction('[Salvage] Correct Price', props<{ batchId: string; newAmount: number; reason: string }>())
export const salvageReturn = createAction('[Salvage] Return Salvage', props<{ batchId: string; reason: string }>())
export const salvageQuoteChanged = createAction('[Salvage] Quote Changed', props<{ claimId: string; itemId: string; reason: string }>())
export const salvageRecalc = createAction('[Salvage] Recalc', props<{ claimId: string }>())
export const salvageRelease = createAction('[Salvage] Release', props<{ claimId: string }>())
export const salvageAdjudicate = createAction('[Salvage] Adjudicate Conflict', props<{ conflictId: string; decision: '确认' | '驳回' }>())
export const salvageRecoverDraft = createAction('[Salvage] Recover Draft', props<{ draftId: string }>())
export const salvageDiscardDraft = createAction('[Salvage] Discard Draft', props<{ draftId: string }>())
export const salvageBackfill = createAction(
  '[Salvage] Backfill By Salvage',
  props<{ claimId: string; items: Array<{ itemId: string; category: string; salvage: number }> }>(),
)
export const salvageSetToast = createAction('[Salvage] Set Toast', props<{ message: string }>())

function findBucket(state: SalvageState, claimId: string): ClaimBucket {
  return (
    state.byClaim[claimId] ?? {
      ...emptyBucket(),
    }
  )
}

function upsertBucket(state: SalvageState, claimId: string, bucket: ClaimBucket): SalvageState {
  return { ...state, byClaim: { ...state.byClaim, [claimId]: bucket } }
}

function updateBatch(state: SalvageState, batchId: string, fn: (b: SalvageBatch) => SalvageBatch): SalvageState {
  const byClaim: Record<string, ClaimBucket> = {}
  for (const [claimId, bucket] of Object.entries(state.byClaim)) {
    byClaim[claimId] = { ...bucket, batches: bucket.batches.map((b) => (b.id === batchId ? fn(b) : b)) }
  }
  return { ...state, byClaim }
}

export const salvageReducer = createReducer(
  initialState(),
  on(salvageInit, (state) => state),
  on(salvageSelectClaim, (state, { claimId }) => ({ ...state, activeClaimId: claimId })),
  on(salvageSubmitBatch, (state, { claimId, sourceItemId, sourceCategory, dealAmount, basis, submittedBy, concurrent }) => {
    const bucket = findBucket(state, claimId)
    const winnerId = uid('SB')
    const winner: SalvageBatch = {
      id: winnerId,
      claimId,
      sourceItemId,
      sourceCategory,
      dealAmount,
      reviewer: '',
      reviewStatus: '待复核',
      submittedBy,
      submittedAt: now(),
      status: '待复核',
      version: 1,
      basis,
      invalid: false,
      invalidReason: '',
      offsetAmount: 0,
      held: false,
    }
    let batches = [...bucket.batches, winner]
    let conflicts = bucket.conflicts
    let toast = `批次 ${winnerId} 已提交，等待复核`
    if (concurrent) {
      // 两名经办同时提交同一批次：先到者生效，后到金额留作冲突
      const loserId = uid('SB')
      const loser: SalvageBatch = { ...winner, id: loserId, submittedBy: '李娜（经办B）', held: true, basis: `${basis}（后到）` }
      batches = [...batches, loser]
      conflicts = [
        ...conflicts,
        {
          id: uid('CF'),
          claimId,
          winnerBatchId: winnerId,
          loserBatchId: loserId,
          sourceCategory,
          amount: dealAmount,
          submittedBy: '李娜（经办B）',
          submittedAt: winner.submittedAt,
          status: '待裁决',
        },
      ]
      toast = `先到批次 ${winnerId} 生效，后到金额 ${dealAmount.toLocaleString()} 元留作冲突`
    }
    return { ...upsertBucket(state, claimId, { ...bucket, batches, conflicts, released: false }), toast }
  }),
  on(salvageReviewBatch, (state, { batchId, reviewer }) =>
    updateBatch(state, batchId, (b) =>
      b.id === batchId
        ? { ...b, reviewStatus: '已复核', reviewer, status: b.status === '已失效' ? b.status : '已复核' }
        : b,
    ),
  ),
  on(salvageOffsetSuccess, (state, { batchId }) =>
    updateBatch(state, batchId, (b) =>
      b.id === batchId ? { ...b, offsetAmount: b.dealAmount, status: '已冲减', invalid: false, invalidReason: '' } : b,
    ),
  ),
  on(salvageOffsetFailure, (state, { claimId, draft }) => {
    const bucket = findBucket(state, claimId)
    return upsertBucket(state, claimId, { ...bucket, drafts: [...bucket.drafts, draft] })
  }),
  on(salvageCorrectPrice, (state, { batchId, newAmount, reason }) =>
    updateBatch(state, batchId, (b) =>
      b.id === batchId
        ? { ...b, dealAmount: newAmount, invalid: true, status: '已失效', invalidReason: `成交价更正：${reason}` }
        : b,
    ),
  ),
  on(salvageReturn, (state, { batchId, reason }) =>
    updateBatch(state, batchId, (b) =>
      b.id === batchId ? { ...b, status: '已退回', invalid: true, invalidReason: `残值退回：${reason}` } : b,
    ),
  ),
  on(salvageQuoteChanged, (state, { claimId, itemId, reason }) => {
    const bucket = findBucket(state, claimId)
    const batches = bucket.batches.map((b) =>
      b.claimId === claimId && b.reviewStatus === '已复核' && b.status !== '已退回'
        ? { ...b, invalid: true, status: '已失效' as const, invalidReason: `科目「${itemId}」报价变化，原分摊失效：${reason}` }
        : b,
    )
    return upsertBucket(state, claimId, { ...bucket, batches, recalcNeeded: true, released: false })
  }),
  on(salvageRecalc, (state, { claimId }) => {
    const bucket = findBucket(state, claimId)
    const batches = bucket.batches.map((b) => {
      if (b.claimId !== claimId || b.status === '已退回' || b.reviewStatus !== '已复核') return b
      if (!b.invalid && b.status !== '已失效' && b.offsetAmount > 0) return b
      // 仅重算此前已冲减/已失效的批次，恢复其分摊
      if (b.invalid || b.status === '已失效' || b.offsetAmount > 0) {
        return { ...b, offsetAmount: b.dealAmount, status: '已冲减' as const, invalid: false, invalidReason: '' }
      }
      return b
    })
    return upsertBucket(state, claimId, { ...bucket, batches, recalcNeeded: false, lastRecalcAt: now(), released: false })
  }),
  on(salvageRelease, (state, { claimId }) => {
    const bucket = findBucket(state, claimId)
    return upsertBucket(state, claimId, { ...bucket, released: true })
  }),
  on(salvageAdjudicate, (state, { conflictId, decision }) => {
    const byClaim: Record<string, ClaimBucket> = {}
    for (const [claimId, bucket] of Object.entries(state.byClaim)) {
      const conflict = bucket.conflicts.find((c) => c.id === conflictId)
      if (!conflict) {
        byClaim[claimId] = bucket
        continue
      }
      const conflicts = bucket.conflicts.map((c) =>
        c.id === conflictId ? { ...c, status: decision === '确认' ? ('已确认' as const) : ('已驳回' as const) } : c,
      )
      let batches = bucket.batches
      if (decision === '驳回') {
        // 驳回：后到批次作废，从批次队列移除
        batches = batches.filter((b) => b.id !== conflict.loserBatchId)
      } else {
        // 确认留冲突：后到金额继续留持，不予冲减
        batches = batches.map((b) => (b.id === conflict.loserBatchId ? { ...b, held: true } : b))
      }
      byClaim[claimId] = { ...bucket, conflicts, batches }
    }
    return { ...state, byClaim }
  }),
  on(salvageRecoverDraft, (state, { draftId }) => {
    const byClaim: Record<string, ClaimBucket> = {}
    for (const [claimId, bucket] of Object.entries(state.byClaim)) {
      const draft = bucket.drafts.find((d) => d.id === draftId)
      if (!draft) {
        byClaim[claimId] = bucket
        continue
      }
      const recovered: SalvageBatch = {
        id: uid('SB'),
        claimId: draft.claimId,
        sourceItemId: draft.sourceItemId,
        sourceCategory: draft.sourceCategory,
        dealAmount: draft.dealAmount,
        reviewer: '',
        reviewStatus: '待复核',
        submittedBy: draft.submittedBy,
        submittedAt: now(),
        status: '待复核',
        version: 1,
        basis: `${draft.basis}（本地恢复）`,
        invalid: false,
        invalidReason: '',
        offsetAmount: 0,
        held: false,
      }
      byClaim[claimId] = { ...bucket, batches: [...bucket.batches, recovered], drafts: bucket.drafts.filter((d) => d.id !== draftId) }
    }
    return { ...state, byClaim }
  }),
  on(salvageDiscardDraft, (state, { draftId }) => {
    const byClaim: Record<string, ClaimBucket> = {}
    for (const [claimId, bucket] of Object.entries(state.byClaim)) {
      byClaim[claimId] = { ...bucket, drafts: bucket.drafts.filter((d) => d.id !== draftId) }
    }
    return { ...state, byClaim }
  }),
  on(salvageBackfill, (state, { claimId, items }) => {
    const bucket = findBucket(state, claimId)
    const existing = new Set(bucket.batches.filter((b) => b.claimId === claimId).map((b) => b.sourceItemId))
    const additions: SalvageBatch[] = items
      .filter((it) => it.salvage > 0 && !existing.has(it.itemId))
      .map((it) => ({
        id: uid('SB'),
        claimId,
        sourceItemId: it.itemId,
        sourceCategory: it.category,
        dealAmount: it.salvage,
        reviewer: '系统补版',
        reviewStatus: '已复核' as const,
        submittedBy: '系统补版',
        submittedAt: now(),
        status: '已冲减' as const,
        version: 1,
        basis: '按残值补版',
        invalid: false,
        invalidReason: '',
        offsetAmount: it.salvage,
        held: false,
      }))
    return upsertBucket(state, claimId, {
      ...bucket,
      batches: [...bucket.batches, ...additions],
      recalcNeeded: false,
      lastRecalcAt: now(),
      released: false,
    })
  }),
  on(salvageSetToast, (state, { message }) => ({ ...state, toast: message })),
)

// 持久化
export function persistSalvage(state: SalvageState): void {
  localStorage.setItem('property-claims-salvage-v1', JSON.stringify(state))
}

export const selectSalvageState = (state: AppState) => state.salvage
export const selectActiveClaimId = createSelector(selectSalvageState, (state) => state.activeClaimId)
export const selectBucket = (claimId: string) =>
  createSelector(selectSalvageState, (state) => state.byClaim[claimId] ?? emptyBucket())
export const selectActiveBucket = createSelector(selectSalvageState, (state) => state.byClaim[state.activeClaimId] ?? emptyBucket())
export const selectActiveBatches = createSelector(selectActiveBucket, (bucket) => bucket.batches)
export const selectActiveConflicts = createSelector(selectActiveBucket, (bucket) => bucket.conflicts)
export const selectActiveDrafts = createSelector(selectActiveBucket, (bucket) => bucket.drafts)
export const selectSalvageToast = createSelector(selectSalvageState, (state) => state.toast)
