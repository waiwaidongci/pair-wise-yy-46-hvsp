import { createAction, createReducer, createSelector, on, props } from '@ngrx/store'
import { seedLedgerEvents, seedSalvageBatches } from './seed'
import type { AppState } from '../core/claims.store'
import type { LedgerEvent, LocalSalvageDraft, PayoutPlanKind, ReleasedPlan, SalvageBatch } from './models'

export type SalvageState = {
  batches: SalvageBatch[]
  localDrafts: LocalSalvageDraft[]
  events: LedgerEvent[]
  selectedClaimId: string
  released: Partial<Record<string, Partial<Record<PayoutPlanKind, ReleasedPlan>>>>
  loading: boolean
  toast: string
}

/** 根状态：残值模块需要同时读取案件与残值两棵状态树 */
export type RootState = AppState & { salvage: SalvageState }

export type SalvageAppState = { salvage: SalvageState }

const STORAGE_KEY = 'property-claims-salvage-v1'

const persistedRaw = localStorage.getItem(STORAGE_KEY)
const persisted: Partial<SalvageState> | null = persistedRaw ? JSON.parse(persistedRaw) : null

export const initialSalvageState: SalvageState = {
  batches: persisted?.batches ? persisted.batches : structuredClone(seedSalvageBatches),
  localDrafts: persisted?.localDrafts ?? [],
  events: persisted?.events ? persisted.events : structuredClone(seedLedgerEvents),
  selectedClaimId: persisted?.selectedClaimId ?? 'CLM-2026-0918',
  released: persisted?.released ?? {},
  loading: false,
  toast: '',
}

export const loadBatches = createAction('[Salvage] Load Batches', props<{ batches: SalvageBatch[] }>())
export const upsertBatch = createAction('[Salvage] Upsert Batch', props<{ batch: SalvageBatch; event?: LedgerEvent }>())
export const selectSalvageClaim = createAction('[Salvage] Select Claim', props<{ claimId: string }>())
export const saveLocalDraft = createAction('[Salvage] Save Local Draft', props<{ draft: LocalSalvageDraft }>())
export const discardLocalDraft = createAction('[Salvage] Discard Local Draft', props<{ id: string }>())
export const appendLedgerEvent = createAction('[Salvage] Append Ledger Event', props<{ event: LedgerEvent }>())
export const releasePlan = createAction('[Salvage] Release Plan', props<{ claimId: string; kind: PayoutPlanKind; released: ReleasedPlan }>())
export const setSalvageToast = createAction('[Salvage] Toast', props<{ message: string }>())

export const salvageReducer = createReducer(
  initialSalvageState,
  on(loadBatches, (state, { batches }) => ({ ...state, batches, loading: false })),
  on(upsertBatch, (state, { batch, event }) => ({
    ...state,
    batches: state.batches.some((item) => item.id === batch.id)
      ? state.batches.map((item) => (item.id === batch.id ? batch : item))
      : [...state.batches, batch],
    events: event ? [event, ...state.events] : state.events,
  })),
  on(selectSalvageClaim, (state, { claimId }) => ({ ...state, selectedClaimId: claimId })),
  on(saveLocalDraft, (state, { draft }) => ({
    ...state,
    localDrafts: [draft, ...state.localDrafts.filter((item) => item.id !== draft.id)],
    toast: '分摊失败，批次已保留到本地暂存，可恢复',
  })),
  on(discardLocalDraft, (state, { id }) => ({
    ...state,
    localDrafts: state.localDrafts.filter((draft) => draft.id !== id),
    toast: '本地暂存批次已丢弃',
  })),
  on(appendLedgerEvent, (state, { event }) => ({ ...state, events: [event, ...state.events] })),
  on(releasePlan, (state, { claimId, kind, released }) => ({
    ...state,
    released: { ...state.released, [claimId]: { ...state.released[claimId], [kind]: released } },
    toast: `赔付方案 ${kind} 已放行`,
  })),
  on(setSalvageToast, (state, { message }) => ({ ...state, toast: message })),
)

export const selectSalvageState = (state: SalvageAppState) => state.salvage
export const selectAllBatches = createSelector(selectSalvageState, (state) => state.batches)
export const selectLocalDrafts = createSelector(selectSalvageState, (state) => state.localDrafts)
export const selectLedgerEvents = createSelector(selectSalvageState, (state) => state.events)
export const selectSalvageClaimId = createSelector(selectSalvageState, (state) => state.selectedClaimId)
export const selectReleasedPlans = createSelector(selectSalvageState, (state) => state.released)

export const selectBatchesByClaim = (claimId: string) =>
  createSelector(selectAllBatches, (batches) => batches.filter((batch) => batch.claimId === claimId))

export const selectDraftsByClaim = (claimId: string) =>
  createSelector(selectLocalDrafts, (drafts) => drafts.filter((draft) => draft.claimId === claimId))
