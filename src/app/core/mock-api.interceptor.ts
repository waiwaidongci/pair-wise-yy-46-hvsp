import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http'
import { delay, of, throwError } from 'rxjs'
import { seedClaims } from './seed'
import { seedSalvageBatches } from '../salvage/seed'
import { AllocationError, allocate, latestQuote } from '../salvage/allocation.engine'
import type { SalvageBatch, SalvageLine, SubmitBatchBody } from '../salvage/models'

let claims = structuredClone(seedClaims)
let salvageBatches: SalvageBatch[] = structuredClone(seedSalvageBatches)

const LATENCY = 200
const respond = <T>(body: T, status = 200) => of(new HttpResponse({ status, body })).pipe(delay(LATENCY))
const fail = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  throwError(() => new HttpErrorResponse({ status, error: { message, ...extra } }))

const now = () => new Date().toLocaleString('zh-CN', { hour12: false })

function nextBatchNo(): string {
  const datePart = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const seq = String(salvageBatches.length + 1).padStart(2, '0')
  return `SB-${datePart}-${seq}`
}

function buildLines(claimId: string, itemIds: string[]): SalvageLine[] {
  const claim = claims.find((item) => item.id === claimId)
  if (!claim) return []
  return itemIds
    .map((itemId) => claim.lossItems.find((loss) => loss.id === itemId))
    .filter((loss): loss is NonNullable<typeof loss> => !!loss)
    .map((loss) => ({
      itemId: loss.id,
      category: loss.category,
      description: loss.description,
      salvageEstimate: loss.salvage,
      quoteVersion: latestQuote(loss).version,
      quoteAmount: latestQuote(loss).amount,
    }))
}

function reallocateEntries(batch: SalvageBatch): { entries: SalvageBatch['entries']; history: SalvageBatch['entryHistory'] } {
  const nextVersion = Math.max(1, ...batch.entries.map((entry) => entry.version), ...batch.entryHistory.map((entry) => entry.version)) + 1
  const history = [...batch.entryHistory, ...batch.entries.map((entry) => ({ ...entry, planLabels: [...entry.planLabels] }))]
  const entries = allocate(batch.lines, batch.dealAmount, batch.returnedAmount, nextVersion)
  return { entries, history }
}

export const mockApiInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) return next(request)

  const url = request.url

  // ---------------- 残值批次 ----------------

  if (request.method === 'GET' && url === '/api/salvage-batches') {
    const claimId = request.params.get('claimId')
    const items = claimId ? salvageBatches.filter((batch) => batch.claimId === claimId) : salvageBatches
    return respond(items)
  }

  if (request.method === 'POST' && url === '/api/salvage-batches') {
    const body = request.body as SubmitBatchBody
    if (body.simulateFail) return fail(500, '网络异常：残值回收系统暂不可用，批次已保留在本地')

    // 并发：同一 clientBatchId 先到者生效，后到者金额留作冲突
    const winner = salvageBatches.find((batch) => batch.clientBatchId === body.clientBatchId)
    if (winner) {
      winner.conflicts.push({
        id: `CFL-${Date.now()}`,
        operator: body.operator,
        dealAmount: body.dealAmount,
        at: now(),
        note: `与已生效批次 ${winner.batchNo} 同时提交，后到金额 ${body.dealAmount.toLocaleString('zh-CN')} 元挂起`,
        resolvedBy: null,
        resolvedAt: null,
        resolution: null,
      })
      return fail(409, `批次已被 ${winner.submittedBy} 先提交生效，本方金额 ${body.dealAmount.toLocaleString('zh-CN')} 元留作冲突待处理`, {
        conflictBatchId: winner.id,
      })
    }

    const claim = claims.find((item) => item.id === body.claimId)
    if (!claim) return fail(404, '案件不存在')
    const lines = buildLines(body.claimId, body.itemIds)
    let entries
    try {
      entries = allocate(lines, body.dealAmount, 0, 1)
    } catch (error) {
      if (error instanceof AllocationError) return fail(422, error.message)
      throw error
    }
    const batch: SalvageBatch = {
      id: `SB-${Date.now()}`,
      clientBatchId: body.clientBatchId,
      batchNo: nextBatchNo(),
      claimId: body.claimId,
      lines,
      dealAmount: body.dealAmount,
      returnedAmount: 0,
      sourceTag: body.sourceTag ?? '常规混卖',
      submittedBy: body.operator,
      submittedAt: now(),
      reviewedBy: null,
      reviewedAt: null,
      reviewStale: false,
      entries,
      entryHistory: [],
      conflicts: [],
    }
    salvageBatches = [...salvageBatches, batch]
    return respond(batch, 201)
  }

  const batchAction = url.match(/^\/api\/salvage-batches\/([^/]+)\/(review|reallocate|correction|return|conflict-resolution)$/)
  if (request.method === 'POST' && batchAction) {
    const [, batchId, action] = batchAction
    const batch = salvageBatches.find((item) => item.id === batchId)
    if (!batch) return fail(404, '残值批次不存在')
    const body = request.body as Record<string, unknown>

    if (action === 'review') {
      if (!batch.entries.length) return fail(422, '缺少分摊分录，无法复核')
      batch.reviewedBy = String(body['reviewer'])
      batch.reviewedAt = now()
      batch.reviewStale = false
      return respond(batch)
    }

    if (action === 'reallocate') {
      try {
        const { entries, history } = reallocateEntries(batch)
        batch.entries = entries
        batch.entryHistory = history
        batch.reviewStale = true
        batch.reviewedBy = null
        batch.reviewedAt = null
        return respond(batch)
      } catch (error) {
        if (error instanceof AllocationError) return fail(422, error.message)
        throw error
      }
    }

    if (action === 'correction') {
      const amount = Number(body['dealAmount'])
      if (!Number.isFinite(amount) || amount < 0) return fail(400, '成交价不合法')
      batch.dealAmount = amount
      const { entries, history } = reallocateEntries(batch)
      batch.entries = entries
      batch.entryHistory = history
      batch.reviewStale = true
      batch.reviewedBy = null
      batch.reviewedAt = null
      return respond(batch)
    }

    if (action === 'return') {
      const amount = Number(body['amount'])
      if (!Number.isFinite(amount) || amount < 0) return fail(400, '退回金额不合法')
      if (amount > batch.dealAmount - batch.returnedAmount) return fail(400, '累计退回金额不能超过成交额')
      batch.returnedAmount += amount
      const { entries, history } = reallocateEntries(batch)
      batch.entries = entries
      batch.entryHistory = history
      batch.reviewStale = true
      batch.reviewedBy = null
      batch.reviewedAt = null
      return respond(batch)
    }

    if (action === 'conflict-resolution') {
      const conflict = batch.conflicts.find((item) => !item.resolvedBy)
      if (!conflict) return fail(404, '没有待处理的冲突金额')
      conflict.resolvedBy = String(body['operator'])
      conflict.resolution = String(body['resolution'])
      conflict.resolvedAt = now()
      return respond(batch)
    }
  }

  const backfillMatch = url.match(/^\/api\/claims\/([^/]+)\/salvage-backfill$/)
  if (request.method === 'POST' && backfillMatch) {
    const claimId = backfillMatch[1]
    const claim = claims.find((item) => item.id === claimId)
    if (!claim) return fail(404, '案件不存在')
    const itemIds = claim.lossItems.filter((loss) => loss.salvage > 0).map((loss) => loss.id)
    const lines = buildLines(claimId, itemIds)
    // 旧案按残值补录：以各科目残值估值合计作为补录成交额
    const dealAmount = lines.reduce((sum, line) => sum + line.salvageEstimate, 0)
    let entries
    try {
      entries = allocate(lines, dealAmount, 0, 1)
    } catch (error) {
      if (error instanceof AllocationError) return fail(422, error.message)
      throw error
    }
    const batch: SalvageBatch = {
      id: `SB-${Date.now()}`,
      clientBatchId: `CLI-BF-${claimId}`,
      batchNo: nextBatchNo(),
      claimId,
      lines,
      dealAmount,
      returnedAmount: 0,
      sourceTag: '按残值补录',
      submittedBy: String((request.body as { operator?: string }).operator ?? '当前用户'),
      submittedAt: now(),
      reviewedBy: null,
      reviewedAt: null,
      reviewStale: false,
      entries,
      entryHistory: [],
      conflicts: [],
    }
    salvageBatches = [...salvageBatches, batch]
    claim.audit.push({
      id: `A-${Date.now()}`,
      at: '刚刚',
      operator: batch.submittedBy,
      action: '残值补录',
      detail: `旧案件缺少分摊依据，按残值补录一版（${dealAmount.toLocaleString('zh-CN')} 元），待复核后冲减。`,
    })
    return respond(batch, 201)
  }

  // 模拟科目报价变化：使按旧版本分摊的批次自动失效
  const bumpMatch = url.match(/^\/api\/claims\/([^/]+)\/salvage-quote-bump$/)
  if (request.method === 'POST' && bumpMatch) {
    const claimId = bumpMatch[1]
    const claim = claims.find((item) => item.id === claimId)
    const itemId = String((request.body as { itemId?: string }).itemId ?? '')
    const item = claim?.lossItems.find((loss) => loss.id === itemId)
    if (!claim || !item) return fail(404, '科目不存在')
    const current = latestQuote(item)
    const nextAmount = Math.round(current.amount * 0.96)
    item.repairQuotes.push({
      version: current.version + 1,
      amount: nextAmount,
      reason: '残值复核联动：报价口径调整（模拟科目报价变化）',
      operator: '残值经办',
      createdAt: now(),
    })
    claim.audit.push({
      id: `A-${Date.now()}`,
      at: '刚刚',
      operator: '系统',
      action: '分摊失效',
      detail: `${item.category}报价更新为 V${current.version + 1}，相关残值批次原分摊依据失效，冲减停止。`,
    })
    return respond({ claim, item })
  }

  // ---------------- 既有案件接口 ----------------

  if (request.method === 'GET' && url === '/api/claims') {
    const query = request.params.get('query')?.toLowerCase() ?? ''
    const status = request.params.get('status') ?? ''
    const risk = request.params.get('risk') ?? ''
    const page = Number(request.params.get('page') ?? 1)
    const pageSize = Number(request.params.get('pageSize') ?? 10)
    const filtered = claims.filter(
      (item) =>
        (!query || `${item.id}${item.insured}${item.policyNo}`.toLowerCase().includes(query)) &&
        (!status || item.status === status) &&
        (!risk || item.riskLevel === risk),
    )
    const start = (page - 1) * pageSize
    return respond({ items: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize })
  }

  if (request.method === 'GET' && url.startsWith('/api/claims/')) {
    const id = url.split('/').pop()
    const item = claims.find((claim) => claim.id === id)
    return item ? respond(item) : fail(404, '案件不存在')
  }

  if (request.method === 'POST' && url.endsWith('/quotes')) {
    const id = url.split('/').at(-2)
    const body = request.body as { itemId: string; amount: number; reason: string }
    const item = claims.find((claim) => claim.id === id)?.lossItems.find((loss) => loss.id === body.itemId)
    if (!item) return fail(404, '科目不存在')
    item.repairQuotes.push({
      version: item.repairQuotes.length + 1,
      amount: body.amount,
      reason: body.reason,
      operator: '当前用户',
      createdAt: now(),
    })
    return respond(item, 201)
  }

  if (request.method === 'POST' && url.endsWith('/approvals')) {
    const id = url.split('/').at(-2)
    const body = request.body as { role: string; result: string; comment: string }
    const item = claims.find((claim) => claim.id === id)
    const step = item?.approvals.find((approval) => approval.role === body.role)
    if (!item || !step) return fail(404, '会签步骤不存在')
    step.status = body.result === '已通过' ? '已通过' : '已退回'
    step.operator = '当前用户'
    step.comment = body.comment
    step.completedAt = now()
    item.status = body.result === '已通过' ? '审批中' : '退回补件'
    item.audit.push({ id: `A-${Date.now()}`, at: '刚刚', operator: '当前用户', action: `会签${step.status}`, detail: body.comment })
    return respond(item)
  }

  return next(request)
}
