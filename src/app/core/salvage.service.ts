import { Injectable } from '@angular/core'
import { delay, of, throwError } from 'rxjs'
import type { ClaimCase } from './models'
import type { LocalBatchDraft, SalvageBatch } from './salvage.models'
import { now, uid, validateOffset } from './salvage.logic'

// 残值分摊接口：模拟后端延迟与校验，状态由 NgRx 管理
@Injectable({ providedIn: 'root' })
export class SalvageService {
  // 提交批次（可模拟两名经办同时提交）
  submitBatch(input: {
    claimId: string
    sourceItemId: string
    sourceCategory: string
    dealAmount: number
    basis: string
    submittedBy: string
    concurrent: boolean
  }) {
    return of({ ok: true }).pipe(delay(260))
  }

  // 复核通过
  reviewBatch(batchId: string, reviewer: string) {
    return of({ ok: true, batchId, reviewer }).pipe(delay(200))
  }

  // 冲减：未复核 / 已退回 / 已失效 / 冲突留持 均拒绝；forcedFail 模拟接口异常
  offsetBatch(batch: SalvageBatch, forcedFail: boolean) {
    if (forcedFail) {
      return throwError(() => new Error('分摊接口异常：冲减服务暂时不可用')).pipe(delay(180))
    }
    const reason = validateOffset(batch)
    if (reason) {
      return throwError(() => new Error(reason)).pipe(delay(180))
    }
    return of({ ok: true, batchId: batch.id }).pipe(delay(320))
  }

  // 成交价更正
  correctPrice(batchId: string, newAmount: number, reason: string) {
    return of({ ok: true, batchId, newAmount, reason }).pipe(delay(220))
  }

  // 残值退回
  returnSalvage(batchId: string, reason: string) {
    return of({ ok: true, batchId, reason }).pipe(delay(220))
  }

  // 科目报价变化
  quoteChanged(claimId: string, itemId: string, reason: string) {
    return of({ ok: true, claimId, itemId, reason }).pipe(delay(220))
  }

  // 重算
  recalc(claimId: string) {
    return of({ ok: true, claimId, at: now() }).pipe(delay(420))
  }

  // 放行
  release(claimId: string) {
    return of({ ok: true, claimId, at: now() }).pipe(delay(200))
  }

  // 旧案件按残值补版
  backfill(claimId: string, items: ClaimCase['lossItems']) {
    return of({ ok: true, claimId, count: items.filter((it) => it.salvage > 0).length }).pipe(delay(360))
  }

  // 冲突裁决
  adjudicate(conflictId: string, decision: '确认' | '驳回') {
    return of({ ok: true, conflictId, decision }).pipe(delay(200))
  }

  // 构造本地批次草稿（分摊失败时保留）
  buildDraft(input: {
    claimId: string
    sourceItemId: string
    sourceCategory: string
    dealAmount: number
    basis: string
    submittedBy: string
    reason: string
  }): LocalBatchDraft {
    return {
      id: uid('LD'),
      claimId: input.claimId,
      sourceItemId: input.sourceItemId,
      sourceCategory: input.sourceCategory,
      dealAmount: input.dealAmount,
      basis: input.basis,
      submittedBy: input.submittedBy,
      savedAt: now(),
      reason: input.reason,
    }
  }
}
