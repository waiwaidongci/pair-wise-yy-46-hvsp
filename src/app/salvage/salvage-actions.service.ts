import { Injectable } from '@angular/core'
import { Store } from '@ngrx/store'
import { Observable, tap } from 'rxjs'
import { SalvageService } from './salvage.service'
import { appendLedgerEvent, upsertBatch, type RootState } from './salvage.store'
import { updateClaim } from '../core/claims.store'
import type { CorrectBody, ResolveConflictBody, ReturnBody, ReviewBody, SalvageBatch, SubmitBatchBody } from './models'
import type { ClaimCase } from '../core/models'

/** 残值动作统一收口：服务端写入成功后同步批次、残值台账事件与案件审计时间线 */
@Injectable({ providedIn: 'root' })
export class SalvageActionsService {
  constructor(
    private readonly salvage: SalvageService,
    private readonly store: Store<RootState>,
  ) {}

  submit(body: SubmitBatchBody): Observable<SalvageBatch> {
    return this.salvage.submit(body).pipe(
      tap((batch) => {
        this.store.dispatch(upsertBatch({ batch }))
        this.record(batch.claimId, body.operator, '批次提交', `${batch.batchNo} 成交额 ${body.dealAmount.toLocaleString('zh-CN')} 元，来源 ${body.itemIds.length} 个科目；分摊已生成待复核。`)
        this.appendClaimAudit(batch.claimId, body.operator, '残值批次提交', `${batch.batchNo} 成交额 ${body.dealAmount.toLocaleString('zh-CN')} 元，分摊待复核，暂不冲减赔付方案。`)
      }),
    )
  }

  review(batchId: string, body: ReviewBody): Observable<SalvageBatch> {
    return this.salvage.review(batchId, body).pipe(
      tap((batch) => {
        this.store.dispatch(upsertBatch({ batch }))
        this.record(batch.claimId, body.reviewer, '批次复核', `${batch.batchNo} 复核通过，回收款 ${(batch.dealAmount - batch.returnedAmount).toLocaleString('zh-CN')} 元开始冲减赔付方案。`)
        this.appendClaimAudit(batch.claimId, body.reviewer, '残值批次复核', `${batch.batchNo} 复核通过，回收款开始冲减。`)
      }),
    )
  }

  reallocate(batchId: string, operator: string): Observable<SalvageBatch> {
    return this.salvage.reallocate(batchId, { reviewer: operator }).pipe(
      tap((batch) => {
        this.store.dispatch(upsertBatch({ batch }))
        this.record(batch.claimId, operator, '重新分摊', `${batch.batchNo} 依据变化后重新分摊 V${batch.entries[0]?.version}，原分录已置为失效留痕，待复核确认。`)
        this.appendClaimAudit(batch.claimId, operator, '残值重新分摊', `${batch.batchNo} 原冲减失效并已重算，复核前不得继续放行。`)
      }),
    )
  }

  correct(batchId: string, body: CorrectBody): Observable<SalvageBatch> {
    return this.salvage.correct(batchId, body).pipe(
      tap((batch) => {
        this.store.dispatch(upsertBatch({ batch }))
        this.record(batch.claimId, body.operator, '成交价更正', `${batch.batchNo} 成交价更正为 ${body.dealAmount.toLocaleString('zh-CN')} 元，原分摊失效并已重算，待复核。`)
        this.appendClaimAudit(batch.claimId, body.operator, '成交价更正', `${batch.batchNo} 更正为 ${body.dealAmount.toLocaleString('zh-CN')} 元，原冲减停止。`)
      }),
    )
  }

  returnSalvage(batchId: string, body: ReturnBody): Observable<SalvageBatch> {
    return this.salvage.returnSalvage(batchId, body).pipe(
      tap((batch) => {
        this.store.dispatch(upsertBatch({ batch }))
        this.record(batch.claimId, body.operator, '残值退回', `${batch.batchNo} 退回 ${body.amount.toLocaleString('zh-CN')} 元，按净额重新分摊，待复核。`)
        this.appendClaimAudit(batch.claimId, body.operator, '残值退回', `${batch.batchNo} 退回 ${body.amount.toLocaleString('zh-CN')} 元，原冲减停止。`)
      }),
    )
  }

  resolveConflict(batchId: string, body: ResolveConflictBody): Observable<SalvageBatch> {
    return this.salvage.resolveConflict(batchId, body).pipe(
      tap((batch) => {
        this.store.dispatch(upsertBatch({ batch }))
        this.record(batch.claimId, body.operator, '冲突处理', `${batch.batchNo} 后到冲突金额已处理：${body.resolution}`)
        this.appendClaimAudit(batch.claimId, body.operator, '残值冲突处理', body.resolution)
      }),
    )
  }

  backfill(claimId: string, operator: string): Observable<SalvageBatch> {
    return this.salvage.backfill(claimId, { reviewer: operator, operator }).pipe(
      tap((batch) => {
        this.store.dispatch(upsertBatch({ batch }))
        this.record(claimId, operator, '按残值补录', `${batch.batchNo} 旧案件缺少分摊依据，按残值补录一版 ${batch.dealAmount.toLocaleString('zh-CN')} 元，待复核。`)
      }),
    )
  }

  bumpQuote(claimId: string, itemId: string): Observable<unknown> {
    return this.salvage.bumpQuote(claimId, { itemId })
  }

  private record(claimId: string, operator: string, action: string, detail: string) {
    this.store.dispatch(
      appendLedgerEvent({ event: { id: `LE-${Date.now()}`, at: new Date().toLocaleString('zh-CN', { hour12: false }), claimId, operator, action, detail } }),
    )
  }

  private appendClaimAudit(claimId: string, operator: string, action: string, detail: string) {
    let claim: ClaimCase | undefined
    this.store
      .select((state: RootState) => state.claims.items.find((item) => item.id === claimId))
      .subscribe((found) => (claim = found))
      .unsubscribe()
    if (!claim) return
    const next: ClaimCase = {
      ...claim,
      audit: [...claim.audit, { id: `A-${Date.now()}`, at: '刚刚', operator, action, detail }],
    }
    this.store.dispatch(updateClaim({ claim: next }))
  }
}
