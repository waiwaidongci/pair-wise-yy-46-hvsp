import { HttpClient } from '@angular/common/http'
import { Injectable } from '@angular/core'
import type { CorrectBody, ResolveConflictBody, ReturnBody, ReviewBody, SalvageBatch, SubmitBatchBody } from './models'

@Injectable({ providedIn: 'root' })
export class SalvageService {
  constructor(private readonly http: HttpClient) {}

  list() {
    return this.http.get<SalvageBatch[]>('/api/salvage-batches')
  }

  submit(body: SubmitBatchBody) {
    return this.http.post<SalvageBatch>('/api/salvage-batches', body)
  }

  review(id: string, body: ReviewBody) {
    return this.http.post<SalvageBatch>(`/api/salvage-batches/${id}/review`, body)
  }

  reallocate(id: string, body: ReviewBody) {
    return this.http.post<SalvageBatch>(`/api/salvage-batches/${id}/reallocate`, body)
  }

  correct(id: string, body: CorrectBody) {
    return this.http.post<SalvageBatch>(`/api/salvage-batches/${id}/correction`, body)
  }

  returnSalvage(id: string, body: ReturnBody) {
    return this.http.post<SalvageBatch>(`/api/salvage-batches/${id}/return`, body)
  }

  resolveConflict(id: string, body: ResolveConflictBody) {
    return this.http.post<SalvageBatch>(`/api/salvage-batches/${id}/conflict-resolution`, body)
  }

  backfill(claimId: string, body: ReviewBody & { operator: string }) {
    return this.http.post<SalvageBatch>(`/api/claims/${claimId}/salvage-backfill`, body)
  }

  /** 模拟科目报价更新（联动真实案件数据，使按旧报价分摊的批次失效） */
  bumpQuote(claimId: string, body: { itemId: string }) {
    return this.http.post(`/api/claims/${claimId}/salvage-quote-bump`, body)
  }
}
