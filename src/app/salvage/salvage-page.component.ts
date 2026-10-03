import { Component, OnInit } from '@angular/core'
import { CommonModule, CurrencyPipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatCardModule } from '@angular/material/card'
import { MatCheckboxModule } from '@angular/material/checkbox'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MatTableModule } from '@angular/material/table'
import { RouterLink } from '@angular/router'
import { HttpErrorResponse } from '@angular/common/http'
import { Store } from '@ngrx/store'
import { combineLatest, map, Observable } from 'rxjs'
import { BatchCardComponent } from './batch-card.component'
import { StatusChipComponent } from '../shared/status-chip.component'
import { SalvageService } from './salvage.service'
import { SalvageActionsService } from './salvage-actions.service'
import { ClaimsService } from '../core/claims.service'
import {
  buildPlanView,
  deriveBatch,
  releaseBlockers,
  type DerivedBatch,
} from './allocation.engine'
import {
  discardLocalDraft,
  loadBatches,
  saveLocalDraft,
  selectAllBatches,
  selectLedgerEvents,
  selectSalvageClaimId,
  selectSalvageClaim as selectClaimAction,
  type RootState,
} from './salvage.store'
import { loadClaimsSuccess, selectAllClaims } from '../core/claims.store'
import type { ClaimCase } from '../core/models'
import type { LedgerEvent, LocalSalvageDraft, SalvageBatch } from './models'

type PageModel = {
  claim: ClaimCase
  claims: ClaimCase[]
  batches: SalvageBatch[]
  derived: DerivedBatch[]
  drafts: LocalSalvageDraft[]
  planView: ReturnType<typeof buildPlanView>
  blockers: string[]
}

@Component({
  selector: 'app-salvage-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CurrencyPipe,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTableModule,
    RouterLink,
    BatchCardComponent,
    StatusChipComponent,
  ],
  template: `
    <section class="page" *ngIf="model$ | async as model">
      <div class="page-head">
        <div>
          <p class="eyebrow">SALVAGE LEDGER / 残值分摊账</p>
          <h1>残值批次 · 分摊分录 · 赔付冲减</h1>
          <p class="muted">混卖回收款按来源科目残值占比分摊；未复核不冲减，依据变化原分摊立即失效。</p>
        </div>
        <div class="actions">
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="claim-picker">
            <mat-label>选择案件</mat-label>
            <mat-select [ngModel]="model.claim.id" (ngModelChange)="switchClaim($event)">
              <mat-option *ngFor="let claim of model.claims" [value]="claim.id">
                {{ claim.id }} · {{ claim.insured }}
              </mat-option>
            </mat-select>
          </mat-form-field>
        </div>
      </div>

      <div class="metrics">
        <mat-card appearance="outlined">
          <span>本案件残值批次</span>
          <strong>{{ model.batches.length }}</strong>
          <small>{{ blockedCount(model) }} 个阻断冲减</small>
        </mat-card>
        <mat-card appearance="outlined">
          <span>生效冲减金额</span>
          <strong>{{ model.planView.totalDeduction | currency: 'CNY':'symbol':'1.0-0' }}</strong>
          <small>仅已复核且依据未变的批次</small>
        </mat-card>
        <mat-card appearance="outlined">
          <span>待处理回收款</span>
          <strong class="warn">{{ pendingAmount(model.derived) | currency: 'CNY':'symbol':'1.0-0' }}</strong>
          <small>待复核 / 已失效重算 / 冲突挂起</small>
        </mat-card>
        <mat-card appearance="outlined">
          <span>方案放行</span>
          <strong [class.warn]="model.blockers.length > 0" [class.good]="model.blockers.length === 0">
            {{ model.blockers.length > 0 ? '冻结' : '可放行' }}
          </strong>
          <small>{{ model.blockers.length > 0 ? model.blockers.length + ' 项阻断' : '无未决残值事项' }}</small>
        </mat-card>
      </div>

      <div class="ledger-grid">
        <div class="left-col">
          <!-- 旧案件补录提示 -->
          <section class="panel backfill-banner" *ngIf="model.batches.length === 0 && hasSalvageEstimate(model.claim)">
            <mat-icon>history_toggle_off</mat-icon>
            <div>
              <strong>旧案件缺少残值分摊依据</strong>
              <p>该案件各科目填报了残值，但回收款从未回拨到科目。请按残值补录一版（补录后仍须复核才能冲减）。</p>
            </div>
            <button mat-flat-button color="primary" (click)="backfill(model.claim)">
              <mat-icon>post_add</mat-icon> 按残值补录一版
            </button>
          </section>

          <!-- 新建批次 -->
          <section class="panel">
            <div class="panel-head">
              <h3>登记残值批次（混卖）</h3>
              <span class="muted">记录来源科目、成交额与经办</span>
            </div>
            <div class="create-form">
              <div class="item-picker">
                <label>来源科目（按残值占比分摊）</label>
                <div *ngFor="let item of model.claim.lossItems" class="item-check" [class.zero]="item.salvage <= 0">
                  <mat-checkbox [(ngModel)]="selectedItemIds[item.id]">
                    {{ item.category }} · {{ item.description }}
                  </mat-checkbox>
                  <small>
                    残值估值 {{ item.salvage | currency: 'CNY':'symbol':'1.0-0' }} ·
                    最新报价 V{{ item.repairQuotes.at(-1)?.version ?? 0 }}
                    {{ item.salvage <= 0 ? '· 残值为 0 不可作为分摊依据' : '' }}
                  </small>
                </div>
              </div>
              <div class="form-grid">
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>成交额（元）</mat-label>
                  <input matInput type="number" [(ngModel)]="dealAmount" />
                </mat-form-field>
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>经办人</mat-label>
                  <input matInput [(ngModel)]="operator" placeholder="姓名 / 岗位" />
                </mat-form-field>
              </div>
              <div class="simulate-row">
                <mat-checkbox [(ngModel)]="simulateFail">模拟网络故障（验证失败后本地保留可恢复）</mat-checkbox>
              </div>
              <div class="actions">
                <button mat-flat-button color="primary" [disabled]="!canSubmit()" (click)="submitBatch(model.claim)">
                  <mat-icon>send</mat-icon> 提交并分摊
                </button>
                <button mat-stroked-button (click)="simulateConcurrent(model.claim)">
                  <mat-icon>groups</mat-icon> 双经办同时提交同批次
                </button>
              </div>
              <small class="muted" *ngIf="!canSubmit() && selectedCount() === 0">请至少选择一个来源科目；仅残值大于 0 的科目可参与分摊。</small>
            </div>
          </section>

          <!-- 本地暂存（失败保留可恢复） -->
          <section class="panel" *ngIf="model.drafts.length > 0">
            <div class="panel-head">
              <h3>本地暂存批次</h3>
              <span class="muted">分摊/提交失败后保留，可恢复或丢弃</span>
            </div>
            <div class="draft-list">
              <article *ngFor="let draft of model.drafts">
                <div class="draft-main">
                  <app-status-chip [label]="draft.failureKind" tone="warn" />
                  <strong>{{ draft.operator }} · 成交额 {{ draft.dealAmount | currency: 'CNY':'symbol':'1.0-0' }}</strong>
                  <small>{{ draft.reason }} · 保留于 {{ draft.at }}</small>
                </div>
                <div class="actions">
                  <button mat-stroked-button color="primary" (click)="restoreDraft(draft, model.claim)">
                    <mat-icon>restore</mat-icon> 恢复并重新提交
                  </button>
                  <button mat-button (click)="dropDraft(draft.id)">丢弃</button>
                </div>
              </article>
            </div>
          </section>

          <!-- 批次卡片 -->
          <div class="batch-list">
            <app-batch-card *ngFor="let batch of model.batches" [batch]="batch" [claim]="model.claim" />
            <section class="panel empty" *ngIf="model.batches.length === 0 && !hasSalvageEstimate(model.claim)">
              <mat-icon>inbox</mat-icon>
              <p>当前案件暂无残值批次，且科目未填报残值。</p>
            </section>
          </div>
        </div>

        <aside class="right-col">
          <!-- 赔付方案冲减 -->
          <section class="panel">
            <div class="panel-head">
              <h3>赔付方案冲减试算</h3>
              <span class="muted">与分摊账实时对账</span>
            </div>
            <div class="plan-summary">
              <div class="plan-line"><span>报价合计</span><strong>{{ model.planView.grossBeforeSalvage | currency: 'CNY':'symbol':'1.0-0' }}</strong></div>
              <div class="plan-line deduct"><span>生效残值冲减</span><strong>- {{ model.planView.totalDeduction | currency: 'CNY':'symbol':'1.0-0' }}</strong></div>
              <div class="plan-cards">
                <mat-card appearance="outlined">
                  <span>方案 A · 现状评估</span>
                  <strong>{{ model.planView.planA | currency: 'CNY':'symbol':'1.0-0' }}</strong>
                </mat-card>
                <mat-card appearance="outlined" class="recommended">
                  <span>方案 B · 核减待证部分</span>
                  <strong>{{ model.planView.planB | currency: 'CNY':'symbol':'1.0-0' }}</strong>
                </mat-card>
              </div>
            </div>
            <div class="table-wrap">
              <table mat-table [dataSource]="model.planView.rows">
                <ng-container matColumnDef="category">
                  <th mat-header-cell *matHeaderCellDef>科目</th>
                  <td mat-cell *matCellDef="let row">
                    {{ row.category }}
                    <small *ngIf="row.disputed">争议项，方案 B 暂扣</small>
                  </td>
                </ng-container>
                <ng-container matColumnDef="deduction">
                  <th mat-header-cell *matHeaderCellDef>残值冲减</th>
                  <td mat-cell *matCellDef="let row">{{ row.salvageDeduction | currency: 'CNY':'symbol':'1.0-0' }}</td>
                </ng-container>
                <ng-container matColumnDef="planA">
                  <th mat-header-cell *matHeaderCellDef>方案 A</th>
                  <td mat-cell *matCellDef="let row">{{ row.contributionA | currency: 'CNY':'symbol':'1.0-0' }}</td>
                </ng-container>
                <ng-container matColumnDef="planB">
                  <th mat-header-cell *matHeaderCellDef>方案 B</th>
                  <td mat-cell *matCellDef="let row">{{ row.contributionB | currency: 'CNY':'symbol':'1.0-0' }}</td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="planColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: planColumns"></tr>
              </table>
            </div>
            <div class="release-box" [class.blocked]="model.blockers.length > 0">
              <mat-icon>{{ model.blockers.length > 0 ? 'lock' : 'lock_open' }}</mat-icon>
              <div>
                <strong>{{ model.blockers.length > 0 ? '赔付方案冻结，不能放行' : '无残值阻断，可在审批页放行' }}</strong>
                <p *ngFor="let blocker of model.blockers">· {{ blocker }}</p>
              </div>
            </div>
            <button class="goto-review" mat-stroked-button color="primary" routerLink="/review">
              <mat-icon>approval</mat-icon> 前往准备金审批放行
            </button>
          </section>

          <!-- 依据变化模拟 -->
          <section class="panel">
            <div class="panel-head"><h3>分摊依据变化模拟</h3><span class="muted">触发即失效</span></div>
            <div class="trigger-list">
              <button mat-stroked-button *ngFor="let item of model.claim.lossItems" (click)="bumpQuote(model.claim, item.id)">
                <mat-icon>trending_down</mat-icon> {{ item.category }}报价调整（新 V{{ item.repairQuotes.at(-1)?.version ?? 0 }} 之后）
              </button>
              <small class="muted">生成新版本报价后，引用旧版本的分摊分录立即置为"已失效"，冲减停止。</small>
            </div>
          </section>

          <!-- 残值台账留痕 -->
          <section class="panel">
            <div class="panel-head"><h3>残值台账留痕</h3><span class="muted">只增不删</span></div>
            <div class="event-list">
              <article *ngFor="let event of eventsForClaim(model)">
                <strong>{{ event.action }}</strong>
                <p>{{ event.detail }}</p>
                <small>{{ event.operator }} · {{ event.at }}</small>
              </article>
            </div>
          </section>
        </aside>
      </div>
    </section>
  `,
  styles: [`
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
    .metrics mat-card { padding: 15px; border-color: #dce3e6; }
    .metrics span, .metrics small { display: block; color: #6e7a83; font-size: 12px; }
    .metrics strong { display: block; margin: 7px 0; color: #153747; font-size: 24px; }
    .warn { color: #b95c2c !important; }
    .good { color: #246d55 !important; }
    .ledger-grid { display: grid; grid-template-columns: minmax(0, 1fr) 390px; gap: 14px; align-items: start; }
    .left-col, .right-col { display: grid; gap: 14px; }
    .claim-picker { width: 300px; }
    .backfill-banner { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-left: 3px solid #2f8191; }
    .backfill-banner mat-icon { color: #2f8191; }
    .backfill-banner p { margin: 5px 0 0; color: #5b6972; font-size: 12px; line-height: 1.5; }
    .backfill-banner button { margin-left: auto; white-space: nowrap; }
    .create-form { padding: 14px 16px 16px; display: grid; gap: 12px; }
    .item-picker > label { display: block; margin-bottom: 6px; color: #53636d; font-size: 12px; font-weight: 700; }
    .item-check { display: flex; flex-direction: column; padding: 6px 8px; border-radius: 6px; }
    .item-check.zero { opacity: .65; }
    .item-check small { margin-left: 26px; color: #8a969e; font-size: 10px; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .simulate-row { font-size: 12px; color: #5b6972; }
    .draft-list { padding: 6px 14px 14px; display: grid; gap: 8px; }
    .draft-list article { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; background: #fff7ef; border: 1px dashed #d59a6c; border-radius: 7px; }
    .draft-main { display: grid; gap: 3px; }
    .draft-main small { color: #8a6a52; font-size: 10px; }
    .batch-list { display: grid; gap: 12px; }
    .empty { display: grid; place-items: center; padding: 30px; color: #87939b; text-align: center; gap: 6px; }
    .plan-summary { padding: 12px 16px 4px; }
    .plan-line { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
    .plan-line.deduct { color: #b95c2c; }
    .plan-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0; }
    .plan-cards mat-card { padding: 11px; }
    .plan-cards .recommended { border-color: #39828b; background: #f0f8f8; }
    .plan-cards span { display: block; color: #69767e; font-size: 10px; }
    .plan-cards strong { display: block; margin-top: 5px; color: #184855; font-size: 16px; }
    .table-wrap { overflow-x: auto; padding: 0 12px; }
    table { width: 100%; }
    td small { display: block; color: #8a969e; font-size: 10px; }
    .release-box { display: flex; gap: 9px; margin: 10px 14px 0; padding: 11px 12px; border-radius: 7px; font-size: 12px; color: #246049; background: #eaf6ef; border-left: 3px solid #3f9a72; }
    .release-box.blocked { color: #763f20; background: #fff3e8; border-left-color: #ce743e; }
    .release-box p { margin: 3px 0 0; }
    .goto-review { margin: 10px 14px 14px; width: calc(100% - 28px); }
    .trigger-list { padding: 10px 14px 14px; display: grid; gap: 8px; }
    .event-list { padding: 8px 16px 14px; max-height: 320px; overflow-y: auto; }
    .event-list article { padding: 9px 0; border-bottom: 1px solid #edf0f2; }
    .event-list strong { font-size: 12px; }
    .event-list p { margin: 4px 0; color: #56656e; font-size: 11px; line-height: 1.5; }
    .event-list small { color: #89949b; font-size: 10px; }
    @media (max-width: 1100px) { .ledger-grid { grid-template-columns: 1fr; } .metrics { grid-template-columns: repeat(2, 1fr); } }
  `],
})
export class SalvagePageComponent implements OnInit {
  readonly planColumns = ['category', 'deduction', 'planA', 'planB']

  model$!: Observable<PageModel>
  eventsForClaimList: LedgerEvent[] = []

  dealAmount: number | null = 50000
  operator = '林淼 / 残值经办'
  selectedItemIds: Record<string, boolean> = {}
  simulateFail = false

  constructor(
    private readonly store: Store<RootState>,
    private readonly salvageService: SalvageService,
    private readonly claimsService: ClaimsService,
    private readonly actions: SalvageActionsService,
    private readonly snackBar: MatSnackBar,
  ) {}

  ngOnInit() {
    this.salvageService.list().subscribe((batches) => this.store.dispatch(loadBatches({ batches })))
    this.store.select(selectLedgerEvents).subscribe((events) => (this.eventsForClaimList = events))

    this.model$ = combineLatest([
      this.store.select(selectAllClaims),
      this.store.select(selectSalvageClaimId),
      this.store.select(selectAllBatches),
      this.store.select(selectLocalDraftsForView),
    ]).pipe(
      map(([claims, selectedId, allBatches, allDrafts]) => {
        const claim = claims.find((item) => item.id === selectedId) ?? claims[0]
        const batches = allBatches.filter((batch) => batch.claimId === claim.id)
        return {
          claim,
          claims,
          batches,
          derived: batches.map((batch) => deriveBatch(batch, claim)),
          drafts: allDrafts.filter((draft) => draft.claimId === claim.id),
          planView: buildPlanView(batches, claim),
          blockers: releaseBlockers(batches, claim),
        }
      }),
    )
  }

  switchClaim(claimId: string) {
    this.store.dispatch(selectClaimAction({ claimId }))
    this.selectedItemIds = {}
  }

  selectedCount() {
    return Object.values(this.selectedItemIds).filter(Boolean).length
  }

  canSubmit() {
    return this.selectedCount() > 0 && !!this.dealAmount && this.dealAmount > 0 && !!this.operator.trim()
  }

  hasSalvageEstimate(claim: ClaimCase) {
    return claim.lossItems.some((item) => item.salvage > 0)
  }

  pendingAmount(derived: DerivedBatch[]) {
    return derived.reduce((sum, batch) => sum + (batch.blockerLabel ? Math.max(0, batch.dealAmount - batch.returnedAmount) : 0), 0)
  }

  blockedCount(model: PageModel) {
    return model.derived.filter((batch) => !!batch.blockerLabel).length
  }

  private chosenItemIds(claim: ClaimCase) {
    return claim.lossItems.filter((item) => this.selectedItemIds[item.id] && item.salvage > 0).map((item) => item.id)
  }

  private persistLocalDraft(claimId: string, itemIds: string[], dealAmount: number, operator: string, failureKind: LocalSalvageDraft['failureKind'], reason: string, clientBatchId: string) {
    const draft: LocalSalvageDraft = {
      id: `DRAFT-${Date.now()}`,
      clientBatchId,
      claimId,
      operator,
      itemIds,
      dealAmount,
      sourceTag: '常规混卖',
      failureKind,
      reason,
      at: new Date().toLocaleString('zh-CN', { hour12: false }),
    }
    this.store.dispatch(saveLocalDraft({ draft }))
  }

  submitBatch(claim: ClaimCase, options?: { draft?: LocalSalvageDraft; clientBatchId?: string }) {
    const draft = options?.draft
    const itemIds = draft?.itemIds ?? this.chosenItemIds(claim)
    const dealAmount = draft?.dealAmount ?? Number(this.dealAmount)
    const operator = draft?.operator ?? this.operator.trim()
    const clientBatchId = options?.clientBatchId ?? draft?.clientBatchId ?? `CLI-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    if (itemIds.length === 0 || dealAmount <= 0 || !operator) return

    this.actions
      .submit({ clientBatchId, claimId: claim.id, itemIds, dealAmount, operator, simulateFail: this.simulateFail })
      .subscribe({
        next: () => {
          if (draft) this.store.dispatch(discardLocalDraft({ id: draft.id }))
          this.simulateFail = false
          this.selectedItemIds = {}
          this.dealAmount = 50000
          this.snackBar.open('批次已提交并完成分摊，复核后才会冲减赔付方案', '关闭', { duration: 2400 })
        },
        error: (error: unknown) => {
          if (error instanceof HttpErrorResponse) {
            if (error.status === 409) {
              // 后到者金额已挂到先到批次，回刷列表使冲突立即可见
              this.refreshBatches()
              this.snackBar.open(error.error?.message ?? '并发冲突', '关闭', { duration: 3000 })
              return
            }
            const failureKind: LocalSalvageDraft['failureKind'] =
              error.status === 422 ? '分摊失败' : '提交失败'
            this.persistLocalDraft(claim.id, itemIds, dealAmount, operator, failureKind, error.error?.message ?? error.message, clientBatchId)
            this.snackBar.open(`${error.error?.message ?? error.message}；批次已保留到本地暂存`, '关闭', { duration: 3000 })
          }
        },
      })
  }

  private refreshBatches() {
    this.salvageService.list().subscribe((batches) => this.store.dispatch(loadBatches({ batches })))
  }

  simulateConcurrent(claim: ClaimCase) {
    const itemIds = this.chosenItemIds(claim)
    const dealAmount = Number(this.dealAmount)
    if (itemIds.length === 0 || dealAmount <= 0) {
      this.snackBar.open('请先选择来源科目并填写成交额', '关闭', { duration: 2200 })
      return
    }
    // 同一 clientBatchId 双经办几乎同时提交：先到者生效，后到金额留作冲突
    const clientBatchId = `CLI-RACE-${Date.now()}`
    const loserDealAmount = Math.max(1000, Math.round(dealAmount * 0.97))
    const first$ = this.actions.submit({ clientBatchId, claimId: claim.id, itemIds, dealAmount, operator: '林淼 / 残值经办' })
    const second$ = this.actions.submit({ clientBatchId, claimId: claim.id, itemIds, dealAmount: loserDealAmount, operator: '秦朗 / 残值经办' })
    first$.subscribe({ next: () => {}, error: () => {} })
    setTimeout(() => {
      second$.subscribe({
        next: () => {},
        error: (error: unknown) => {
          if (error instanceof HttpErrorResponse && error.status === 409) {
            this.refreshBatches()
            this.snackBar.open(`先到者（林淼）已生效；后到金额 ${loserDealAmount.toLocaleString('zh-CN')} 元留作冲突挂起`, '关闭', { duration: 3200 })
          }
        },
      })
    }, 60)
  }

  restoreDraft(draft: LocalSalvageDraft, claim: ClaimCase) {
    this.selectedItemIds = {}
    for (const itemId of draft.itemIds) this.selectedItemIds[itemId] = true
    this.dealAmount = draft.dealAmount
    this.operator = draft.operator
    this.simulateFail = false
    this.submitBatch(claim, { draft })
  }

  dropDraft(id: string) {
    this.store.dispatch(discardLocalDraft({ id }))
  }

  backfill(claim: ClaimCase) {
    this.actions.backfill(claim.id, this.operator.trim() || '林淼 / 残值经办').subscribe({
      next: () => this.snackBar.open('已按残值补录一版分摊账，复核前不冲减', '关闭', { duration: 2600 }),
      error: (error: unknown) => this.snackBar.open(error instanceof HttpErrorResponse ? error.message : '补录失败', '关闭', { duration: 2400 }),
    })
  }

  bumpQuote(claim: ClaimCase, itemId: string) {
    this.actions.bumpQuote(claim.id, itemId).subscribe({
      next: () => {
        // 刷新案件（报价新版本），批次派生状态随之失效
        this.claimsService
          .list({ query: '', status: '', risk: '', page: 1, pageSize: 50 })
          .subscribe((page) => this.store.dispatch(loadClaimsSuccess({ items: page.items, total: page.total })))
        this.snackBar.open('科目报价已生成新版本，相关分摊分录立即失效，冲减停止', '关闭', { duration: 2800 })
      },
      error: () => this.snackBar.open('报价调整失败', '关闭', { duration: 2000 }),
    })
  }

  eventsForClaim(model: PageModel) {
    return this.eventsForClaimList.filter((event) => event.claimId === model.claim.id)
  }
}

// 视图用简单选择器（避免在 combineLatest 中重复创建工厂选择器）
const selectLocalDraftsForView = (state: RootState) => state.salvage.localDrafts
