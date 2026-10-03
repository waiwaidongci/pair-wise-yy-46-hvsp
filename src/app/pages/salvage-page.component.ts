import { Component } from '@angular/core'
import { CommonModule, CurrencyPipe, PercentPipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatCardModule } from '@angular/material/card'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatCheckboxModule } from '@angular/material/checkbox'
import { MatTableModule } from '@angular/material/table'
import { MatSnackBar } from '@angular/material/snack-bar'
import { Store } from '@ngrx/store'
import { combineLatest, map } from 'rxjs'
import type { ClaimCase } from '../core/models'
import type { AllocationLedger, AllocationRecord, BatchConflict, LocalBatchDraft, SalvageBatch } from '../core/salvage.models'
import { SalvageService } from '../core/salvage.service'
import { buildLedger, computeAllocations, MIXED, releaseBlockers } from '../core/salvage.logic'
import {
  salvageAdjudicate,
  salvageBackfill,
  salvageCorrectPrice,
  salvageDiscardDraft,
  salvageOffsetFailure,
  salvageOffsetSuccess,
  salvageQuoteChanged,
  salvageRecalc,
  salvageRecoverDraft,
  salvageRelease,
  salvageReturn,
  salvageReviewBatch,
  salvageSelectClaim,
  salvageSetToast,
  salvageSubmitBatch,
  selectActiveBatches,
  selectActiveBucket,
  selectActiveClaimId,
  selectActiveConflicts,
  selectActiveDrafts,
  selectSalvageToast,
} from '../core/salvage.store'
import { selectAllClaims, selectClaim, type AppState } from '../core/claims.store'
import { StatusChipComponent } from '../shared/status-chip.component'

@Component({
  selector: 'app-salvage-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CurrencyPipe,
    PercentPipe,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule,
    MatTableModule,
    StatusChipComponent,
  ],
  template: `
    <section class="page" *ngIf="claim$ | async as claim">
      <div class="page-head">
        <div>
          <p class="eyebrow">SALVAGE ALLOCATION / 残值分摊</p>
          <h1>残值分摊账</h1>
          <p class="muted">按科目登记残值批次，混卖回收款分摊冲减，并与赔付方案对接。</p>
        </div>
        <div class="actions">
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="claim-select">
            <mat-label>切换案件</mat-label>
            <mat-select [ngModel]="claim.id" (ngModelChange)="switchClaim($event)">
              <mat-option *ngFor="let c of claims$ | async" [value]="c.id">{{ c.id }} · {{ c.insured }}</mat-option>
            </mat-select>
          </mat-form-field>
          <button mat-stroked-button color="primary" (click)="backfill(claim)" *ngIf="(batches$ | async)?.length === 0">
            <mat-icon>auto_fix_high</mat-icon> 按残值补一版
          </button>
          <button mat-stroked-button (click)="recalc(claim)" [disabled]="!(bucket$ | async)?.recalcNeeded">
            <mat-icon>refresh</mat-icon> 重算分摊
          </button>
          <button mat-flat-button color="primary" (click)="release(claim)"><mat-icon>verified</mat-icon> 放行</button>
        </div>
      </div>

      <mat-card appearance="outlined" class="banner warn-banner" *ngIf="(bucket$ | async)?.recalcNeeded">
        <mat-icon>warning_amber</mat-icon>
        <div><strong>分摊已失效，需重算后才能放行</strong><span>成交价更正、残值退回或科目报价变化后，原分摊金额已作废，请重新计算。</span></div>
        <button mat-stroked-button color="warn" (click)="recalc(claim)">立即重算</button>
      </mat-card>

      <mat-card appearance="outlined" class="banner ok-banner" *ngIf="(bucket$ | async)?.released && !(bucket$ | async)?.recalcNeeded">
        <mat-icon>check_circle</mat-icon>
        <div><strong>分摊账已放行</strong><span>回收款已按科目冲减，赔付方案可据此核销。</span></div>
      </mat-card>

      <div class="summary-grid" *ngIf="ledger$ | async as ledger">
        <mat-card appearance="outlined"><span>预估残值</span><strong>{{ ledger.estimatedSalvage | currency:'CNY':'symbol':'1.0-0' }}</strong><small>按科目填列</small></mat-card>
        <mat-card appearance="outlined"><span>已回收冲减</span><strong class="good">{{ ledger.recovered | currency:'CNY':'symbol':'1.0-0' }}</strong><small>已复核且有效</small></mat-card>
        <mat-card appearance="outlined"><span>待复核</span><strong class="muted-strong">{{ ledger.pendingReview | currency:'CNY':'symbol':'1.0-0' }}</strong><small>未复核不能冲减</small></mat-card>
        <mat-card appearance="outlined"><span>失效待重算</span><strong class="warn">{{ ledger.invalidAmount | currency:'CNY':'symbol':'1.0-0' }}</strong><small>不能继续放行</small></mat-card>
        <mat-card appearance="outlined"><span>回收差异</span><strong [class.warn]="ledger.variance !== 0">{{ ledger.variance | currency:'CNY':'symbol':'1.0-0' }}</strong><small>预估 - 已回收</small></mat-card>
        <mat-card appearance="outlined"><span>残值覆盖率</span><strong>{{ ledger.coverageRatio | percent:'1.0-0' }}</strong><small>已回收 / 预估</small></mat-card>
      </div>

      <div class="alloc-grid">
        <div class="main-col">
          <section class="panel">
            <div class="panel-head"><h3>提交残值批次</h3><span class="muted">记录来源科目、成交额与经办人</span></div>
            <div class="submit-form">
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>来源科目</mat-label>
                <mat-select [(ngModel)]="form.sourceItemId">
                  <mat-option *ngFor="let it of claim.lossItems" [value]="it.id">{{ it.category }}（预估 {{ it.salvage | currency:'CNY':'symbol':'1.0-0' }}）</mat-option>
                  <mat-option [value]="MIXED">混卖（按残值比例分摊）</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline" subscriptSizing="dynamic" class="amount-field">
                <mat-label>成交额</mat-label>
                <input matInput type="number" [(ngModel)]="form.dealAmount" />
              </mat-form-field>
              <mat-form-field appearance="outline" subscriptSizing="dynamic" class="basis-field">
                <mat-label>分摊依据</mat-label>
                <input matInput [(ngModel)]="form.basis" placeholder="如：回收商报价单 / 混卖协议" />
              </mat-form-field>
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>经办人</mat-label>
                <input matInput [(ngModel)]="form.submittedBy" />
              </mat-form-field>
              <label class="check"><input type="checkbox" [(ngModel)]="form.forcedFail" /> 模拟分摊接口异常</label>
              <button mat-flat-button color="primary" [disabled]="!canSubmit()" (click)="submit(claim)">提交批次</button>
              <button mat-stroked-button (click)="submitConcurrent(claim)" [disabled]="!canSubmit()">模拟两名经办同时提交</button>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>残值批次</h3><span class="muted">{{ (batches$ | async)?.length }} 笔 · 未复核不能冲减</span></div>
            <div class="table-wrap">
              <table mat-table [dataSource]="(batches$ | async) ?? []">
                <ng-container matColumnDef="id"><th mat-header-cell *matHeaderCellDef>批次号</th><td mat-cell *matCellDef="let b"><strong>{{ b.id }}</strong><small>V{{ b.version }} · {{ b.submittedAt }}</small></td></ng-container>
                <ng-container matColumnDef="source"><th mat-header-cell *matHeaderCellDef>来源科目</th><td mat-cell *matCellDef="let b">{{ b.sourceCategory }}<small>{{ b.submittedBy }}</small></td></ng-container>
                <ng-container matColumnDef="amount"><th mat-header-cell *matHeaderCellDef>成交额</th><td mat-cell *matCellDef="let b">{{ b.dealAmount | currency:'CNY':'symbol':'1.0-0' }}<small *ngIf="b.offsetAmount">已冲 {{ b.offsetAmount | currency:'CNY':'symbol':'1.0-0' }}</small></td></ng-container>
                <ng-container matColumnDef="reviewer"><th mat-header-cell *matHeaderCellDef>复核人</th><td mat-cell *matCellDef="let b">{{ b.reviewer || '—' }}<small *ngIf="b.held" class="warn">冲突留持</small></td></ng-container>
                <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>状态</th><td mat-cell *matCellDef="let b"><app-status-chip [label]="b.status" [tone]="statusTone(b.status)" /><small *ngIf="b.invalid" class="warn">{{ b.invalidReason }}</small></td></ng-container>
                <ng-container matColumnDef="actions">
                  <th mat-header-cell *matHeaderCellDef></th>
                  <td mat-cell *matCellDef="let b" class="row-actions">
                    <ng-container [ngSwitch]="b.status">
                      <button *ngSwitchCase="'待复核'" mat-button color="primary" (click)="review(b)" [disabled]="b.held">复核</button>
                      <button *ngSwitchCase="'已复核'" mat-button color="primary" (click)="offset(b)">冲减</button>
                      <button *ngSwitchCase="'已冲减'" mat-button (click)="startEdit(b, 'correct')">成交价更正</button>
                      <ng-container *ngSwitchDefault><span class="muted">—</span></ng-container>
                    </ng-container>
                    <button *ngIf="b.status === '已冲减'" mat-button color="warn" (click)="startEdit(b, 'return')">退回</button>
                    <button *ngIf="b.status === '已失效'" mat-button (click)="recalc(claim)">重算</button>
                  </td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="batchColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: batchColumns"></tr>
              </table>
            </div>

            <div class="inline-edit" *ngIf="editing">
              <ng-container *ngIf="editing.type === 'correct'">
                <strong>成交价更正 · {{ editing.batch.id }}</strong>
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="small"><mat-label>新成交额</mat-label><input matInput type="number" [(ngModel)]="editing.newAmount" /></mat-form-field>
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="basis-field"><mat-label>更正理由</mat-label><input matInput [(ngModel)]="editing.reason" placeholder="必填，更正后原分摊失效" /></mat-form-field>
                <button mat-flat-button color="primary" [disabled]="!editing.reason.trim()" (click)="confirmCorrect()">确认更正</button>
              </ng-container>
              <ng-container *ngIf="editing.type === 'return'">
                <strong>残值退回 · {{ editing.batch.id }}</strong>
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="basis-field"><mat-label>退回原因</mat-label><input matInput [(ngModel)]="editing.reason" placeholder="必填，退回后原分摊失效" /></mat-form-field>
                <button mat-flat-button color="warn" [disabled]="!editing.reason.trim()" (click)="confirmReturn()">确认退回</button>
              </ng-container>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>分摊账分录</h3><span class="muted">由有效批次按规则推导</span></div>
            <div class="table-wrap">
              <table mat-table [dataSource]="(allocations$ | async) ?? []">
                <ng-container matColumnDef="batch"><th mat-header-cell *matHeaderCellDef>批次</th><td mat-cell *matCellDef="let a"><strong>{{ a.batchId }}</strong><small>V{{ a.version }} · {{ a.allocatedAt }}</small></td></ng-container>
                <ng-container matColumnDef="category"><th mat-header-cell *matHeaderCellDef>分摊科目</th><td mat-cell *matCellDef="let a">{{ a.category }}</td></ng-container>
                <ng-container matColumnDef="amount"><th mat-header-cell *matHeaderCellDef>冲减金额</th><td mat-cell *matCellDef="let a">{{ a.amount | currency:'CNY':'symbol':'1.0-0' }}</td></ng-container>
                <ng-container matColumnDef="basis"><th mat-header-cell *matHeaderCellDef>分摊依据</th><td mat-cell *matCellDef="let a">{{ a.basis }}</td></ng-container>
                <tr mat-header-row *matHeaderRowDef="allocColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: allocColumns"></tr>
              </table>
              <p class="muted empty" *ngIf="(allocations$ | async)?.length === 0">暂无有效分摊分录，请先复核并冲减批次。</p>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>科目分摊对照</h3><span class="muted">回收款与赔付方案差异</span></div>
            <div class="table-wrap">
              <table mat-table [dataSource]="(ledger$ | async)?.perItem ?? []">
                <ng-container matColumnDef="category"><th mat-header-cell *matHeaderCellDef>科目</th><td mat-cell *matCellDef="let it"><strong>{{ it.category }}</strong><small>{{ it.description }}</small></td></ng-container>
                <ng-container matColumnDef="estimated"><th mat-header-cell *matHeaderCellDef>预估残值</th><td mat-cell *matCellDef="let it">{{ it.estimated | currency:'CNY':'symbol':'1.0-0' }}</td></ng-container>
                <ng-container matColumnDef="allocated"><th mat-header-cell *matHeaderCellDef>已分摊</th><td mat-cell *matCellDef="let it">{{ it.allocated | currency:'CNY':'symbol':'1.0-0' }}</td></ng-container>
                <ng-container matColumnDef="variance"><th mat-header-cell *matHeaderCellDef>差异</th><td mat-cell *matCellDef="let it"><span [class.warn]="it.variance !== 0">{{ it.variance | currency:'CNY':'symbol':'1.0-0' }}</span></td></ng-container>
                <ng-container matColumnDef="action">
                  <th mat-header-cell *matHeaderCellDef></th>
                  <td mat-cell *matCellDef="let it"><button mat-button (click)="startQuoteChange(it)">报价变化</button></td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="itemColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: itemColumns"></tr>
              </table>
            </div>
            <div class="inline-edit" *ngIf="quoteChangeItem">
              <strong>科目报价变化 · {{ quoteChangeItem.category }}</strong>
              <mat-form-field appearance="outline" subscriptSizing="dynamic" class="basis-field"><mat-label>变化说明</mat-label><input matInput [(ngModel)]="quoteChangeReason" placeholder="必填，变化后原分摊失效" /></mat-form-field>
              <button mat-flat-button color="primary" [disabled]="!quoteChangeReason.trim()" (click)="confirmQuoteChange(claim)">确认并失效重算</button>
            </div>
          </section>
        </div>

        <aside class="side-col">
          <section class="panel release-panel">
            <div class="panel-head"><h3>放行核验</h3><app-status-chip [label]="(bucket$ | async)?.released ? '已放行' : '未放行'" [tone]="(bucket$ | async)?.released ? 'good' : 'warn'" /></div>
            <div class="release-body">
              <ul class="blockers" *ngIf="blockers$ | async as blockers">
                <li *ngFor="let b of blockers" class="warn"><mat-icon>block</mat-icon>{{ b }}</li>
                <li *ngIf="blockers.length === 0" class="good"><mat-icon>check_circle</mat-icon>核验通过，可放行</li>
              </ul>
              <button mat-flat-button color="primary" (click)="release(claim)" [disabled]="(blockers$ | async)?.length">
                <mat-icon>verified</mat-icon> 放行
              </button>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>批次金额冲突</h3><span class="muted">先到者生效 · 后到留持</span></div>
            <div class="conflict-list">
              <div *ngFor="let c of conflicts$ | async" class="conflict" [class.done]="c.status !== '待裁决'">
                <div class="conflict-head">
                  <strong>{{ c.sourceCategory }}</strong>
                  <app-status-chip [label]="c.status" [tone]="c.status === '待裁决' ? 'warn' : 'good'" />
                </div>
                <p>后到金额 <strong class="warn">{{ c.amount | currency:'CNY':'symbol':'1.0-0' }}</strong> · {{ c.submittedBy }}</p>
                <small>先到批次 {{ c.winnerBatchId }} 已生效 · {{ c.submittedAt }}</small>
                <div class="conflict-actions" *ngIf="c.status === '待裁决'">
                  <button mat-stroked-button color="warn" (click)="adjudicate(c, '确认')">确认留冲突</button>
                  <button mat-stroked-button (click)="adjudicate(c, '驳回')">驳回后到</button>
                </div>
              </div>
              <p class="muted empty" *ngIf="(conflicts$ | async)?.length === 0">暂无冲突。</p>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>本地批次草稿</h3><span class="muted">分摊失败保留 · 可恢复</span></div>
            <div class="draft-list">
              <div *ngFor="let d of drafts$ | async" class="draft">
                <div class="draft-head">
                  <strong>{{ d.sourceCategory }}</strong>
                  <small>{{ d.savedAt }}</small>
                </div>
                <p>成交额 {{ d.dealAmount | currency:'CNY':'symbol':'1.0-0' }} · {{ d.submittedBy }}</p>
                <small class="warn">失败原因：{{ d.reason }}</small>
                <div class="draft-actions">
                  <button mat-flat-button color="primary" (click)="recover(d)"><mat-icon>restore</mat-icon> 恢复并提交</button>
                  <button mat-button (click)="discard(d)">删除</button>
                </div>
              </div>
              <p class="muted empty" *ngIf="(drafts$ | async)?.length === 0">暂无本地草稿。</p>
            </div>
          </section>
        </aside>
      </div>
    </section>
  `,
  styles: [`
    .banner { display: flex; align-items: center; gap: 12px; padding: 14px 16px; margin-bottom: 14px; }
    .banner mat-icon { font-size: 26px; width: 26px; height: 26px; }
    .banner div { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .banner span { color: #6c7882; font-size: 12px; }
    .warn-banner { border-color: #ce743e; background: #fff7f1; }
    .warn-banner mat-icon { color: #ce743e; }
    .ok-banner { border-color: #3f9c73; background: #f1faf5; }
    .ok-banner mat-icon { color: #3f9c73; }
    .summary-grid { display: grid; grid-template-columns: repeat(6, minmax(0,1fr)); gap: 12px; margin-bottom: 14px; }
    .summary-grid mat-card { padding: 14px; border-color: #dce3e6; }
    .summary-grid span, .summary-grid small { display: block; color: #6e7a83; font-size: 11px; }
    .summary-grid strong { display: block; margin: 6px 0; color: #153747; font-size: 22px; }
    .muted-strong { color: #5a6770 !important; }
    .good { color: #246d55 !important; }
    .warn { color: #b55a2e !important; }
    .alloc-grid { display: grid; grid-template-columns: minmax(0,1fr) 340px; gap: 14px; align-items: start; }
    .main-col { display: grid; gap: 14px; }
    .side-col { display: grid; gap: 14px; }
    .submit-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 14px 16px; }
    .submit-form mat-form-field { min-width: 160px; }
    .amount-field { width: 140px; }
    .basis-field { flex: 1; min-width: 220px; }
    .check { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #6c7882; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; min-width: 640px; }
    td small { display: block; margin-top: 3px; color: #7b8790; font-size: 10px; }
    .row-actions { white-space: nowrap; }
    .inline-edit { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px 16px; border-top: 1px solid #e6ebed; background: #f7fafb; }
    .inline-edit mat-form-field { min-width: 160px; }
    .small { width: 130px; }
    .empty { padding: 16px; text-align: center; }
    .release-panel .release-body { padding: 14px 16px; }
    .blockers { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 8px; }
    .blockers li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .blockers mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .release-panel button { width: 100%; }
    .conflict-list, .draft-list { padding: 10px 14px 14px; display: grid; gap: 10px; }
    .conflict, .draft { padding: 10px 12px; border: 1px solid #e6ebed; border-radius: 8px; background: #fafcfc; }
    .conflict.done { opacity: .7; }
    .conflict-head, .draft-head { display: flex; align-items: center; justify-content: space-between; }
    .conflict p, .draft p { margin: 6px 0 2px; font-size: 12px; }
    .conflict small, .draft small { color: #7b8790; font-size: 10px; }
    .conflict-actions, .draft-actions { display: flex; gap: 8px; margin-top: 8px; }
    .claim-select { width: 220px; }
    @media (max-width: 1200px) { .summary-grid { grid-template-columns: repeat(3, minmax(0,1fr)); } }
    @media (max-width: 1050px) { .alloc-grid { grid-template-columns: 1fr; } }
    @media (max-width: 680px) { .summary-grid { grid-template-columns: repeat(2, minmax(0,1fr)); } }
  `],
})
export class SalvagePageComponent {
  claim$: ReturnType<SalvagePageComponent['claimStream']>
  claims$: ReturnType<SalvagePageComponent['claimsStream']>
  bucket$: ReturnType<SalvagePageComponent['bucketStream']>
  batches$: ReturnType<SalvagePageComponent['batchesStream']>
  conflicts$: ReturnType<SalvagePageComponent['conflictsStream']>
  drafts$: ReturnType<SalvagePageComponent['draftsStream']>
  ledger$: ReturnType<SalvagePageComponent['ledgerStream']>
  allocations$: ReturnType<SalvagePageComponent['allocationsStream']>
  blockers$: ReturnType<SalvagePageComponent['blockersStream']>

  readonly MIXED = MIXED
  batchColumns = ['id', 'source', 'amount', 'reviewer', 'status', 'actions']
  allocColumns = ['batch', 'category', 'amount', 'basis']
  itemColumns = ['category', 'estimated', 'allocated', 'variance', 'action']

  form = { sourceItemId: '', dealAmount: 0, basis: '', submittedBy: '当前用户', forcedFail: false }
  editing: { batch: SalvageBatch; type: 'correct' | 'return'; newAmount: number; reason: string } | null = null
  quoteChangeItem: { itemId: string; category: string } | null = null
  quoteChangeReason = ''
  private latestBucket: { batches: SalvageBatch[]; conflicts: BatchConflict[] } | null = null

  private claimStream() {
    return combineLatest([this.store.select(selectAllClaims), this.store.select(selectActiveClaimId)]).pipe(
      map(([claims, id]) => claims.find((c) => c.id === id) ?? claims[0]),
    )
  }
  private claimsStream() {
    return this.store.select(selectAllClaims)
  }
  private bucketStream() {
    return this.store.select(selectActiveBucket)
  }
  private batchesStream() {
    return this.store.select(selectActiveBatches)
  }
  private conflictsStream() {
    return this.store.select(selectActiveConflicts)
  }
  private draftsStream() {
    return this.store.select(selectActiveDrafts)
  }
  private ledgerStream() {
    return combineLatest([this.claimStream(), this.batchesStream()]).pipe(map(([claim, batches]) => buildLedger(claim, batches)))
  }
  private allocationsStream() {
    return combineLatest([this.claimStream(), this.batchesStream()]).pipe(map(([claim, batches]) => computeAllocations(claim, batches)))
  }
  private blockersStream() {
    return combineLatest([this.claimStream(), this.batchesStream(), this.conflictsStream()]).pipe(
      map(([claim, batches, conflicts]) => releaseBlockers(claim.id, batches, conflicts)),
    )
  }

  constructor(
    private readonly store: Store<AppState>,
    private readonly service: SalvageService,
    private readonly snackBar: MatSnackBar,
  ) {
    this.claim$ = this.claimStream()
    this.claims$ = this.claimsStream()
    this.bucket$ = this.bucketStream()
    this.batches$ = this.batchesStream()
    this.conflicts$ = this.conflictsStream()
    this.drafts$ = this.draftsStream()
    this.ledger$ = this.ledgerStream()
    this.allocations$ = this.allocationsStream()
    this.blockers$ = this.blockersStream()

    this.bucket$.subscribe((bucket) => (this.latestBucket = bucket))

    // 与全局选中案件同步
    combineLatest([this.store.select(selectAllClaims), this.store.select(selectActiveClaimId)]).subscribe(([claims, id]) => {
      const exists = claims.some((c) => c.id === id)
      if (!exists && claims[0]) this.store.dispatch(salvageSelectClaim({ claimId: claims[0].id }))
    })
    this.store.select(selectSalvageToast).subscribe((toast) => {
      if (toast) {
        this.snackBar.open(toast, '关闭', { duration: 2400 })
        this.store.dispatch(salvageSetToast({ message: '' }))
      }
    })
  }

  switchClaim(claimId: string) {
    this.store.dispatch(salvageSelectClaim({ claimId }))
    this.store.dispatch(selectClaim({ id: claimId }))
  }

  canSubmit() {
    return this.form.sourceItemId && this.form.dealAmount > 0 && this.form.basis.trim()
  }

  submit(claim: ClaimCase) {
    if (!this.canSubmit()) return
    const sourceCategory = this.form.sourceItemId === MIXED ? '混卖' : claim.lossItems.find((it) => it.id === this.form.sourceItemId)?.category ?? ''
    this.service
      .submitBatch({
        claimId: claim.id,
        sourceItemId: this.form.sourceItemId,
        sourceCategory,
        dealAmount: Number(this.form.dealAmount),
        basis: this.form.basis.trim(),
        submittedBy: this.form.submittedBy,
        concurrent: false,
      })
      .subscribe(() => {
        this.store.dispatch(
          salvageSubmitBatch({
            claimId: claim.id,
            sourceItemId: this.form.sourceItemId,
            sourceCategory,
            dealAmount: Number(this.form.dealAmount),
            basis: this.form.basis.trim(),
            submittedBy: this.form.submittedBy,
            concurrent: false,
          }),
        )
        this.snackBar.open('批次已提交，等待复核', '关闭', { duration: 1800 })
        this.form.dealAmount = 0
      })
  }

  submitConcurrent(claim: ClaimCase) {
    if (!this.canSubmit()) return
    const sourceCategory = this.form.sourceItemId === MIXED ? '混卖' : claim.lossItems.find((it) => it.id === this.form.sourceItemId)?.category ?? ''
    this.service
      .submitBatch({
        claimId: claim.id,
        sourceItemId: this.form.sourceItemId,
        sourceCategory,
        dealAmount: Number(this.form.dealAmount),
        basis: this.form.basis.trim(),
        submittedBy: this.form.submittedBy,
        concurrent: true,
      })
      .subscribe(() => {
        this.store.dispatch(
          salvageSubmitBatch({
            claimId: claim.id,
            sourceItemId: this.form.sourceItemId,
            sourceCategory,
            dealAmount: Number(this.form.dealAmount),
            basis: this.form.basis.trim(),
            submittedBy: this.form.submittedBy,
            concurrent: true,
          }),
        )
        this.form.dealAmount = 0
      })
  }

  review(batch: SalvageBatch) {
    this.service.reviewBatch(batch.id, '王复核').subscribe(() => {
      this.store.dispatch(salvageReviewBatch({ batchId: batch.id, reviewer: '王复核' }))
      this.snackBar.open('复核通过，批次可冲减', '关闭', { duration: 1800 })
    })
  }

  offset(batch: SalvageBatch) {
    const claimId = batch.claimId
    this.service.offsetBatch(batch, this.form.forcedFail).subscribe({
      next: () => {
        this.store.dispatch(salvageOffsetSuccess({ batchId: batch.id }))
        this.snackBar.open(`批次 ${batch.id} 已冲减 ${batch.dealAmount.toLocaleString()} 元`, '关闭', { duration: 1800 })
      },
      error: (err) => {
        const reason = err?.message ?? '分摊失败'
        const draft = this.service.buildDraft({
          claimId,
          sourceItemId: batch.sourceItemId,
          sourceCategory: batch.sourceCategory,
          dealAmount: batch.dealAmount,
          basis: batch.basis,
          submittedBy: batch.submittedBy,
          reason,
        })
        this.store.dispatch(salvageOffsetFailure({ claimId, draft }))
        this.snackBar.open(`分摊失败：${reason}。已保留为本地批次，可恢复`, '关闭', { duration: 2600 })
      },
    })
  }

  startEdit(batch: SalvageBatch, type: 'correct' | 'return') {
    this.editing = { batch, type, newAmount: batch.dealAmount, reason: '' }
    this.quoteChangeItem = null
  }

  confirmCorrect() {
    if (!this.editing || !this.editing.reason.trim()) return
    const { batch, newAmount, reason } = this.editing
    this.service.correctPrice(batch.id, Number(newAmount), reason.trim()).subscribe(() => {
      this.store.dispatch(salvageCorrectPrice({ batchId: batch.id, newAmount: Number(newAmount), reason: reason.trim() }))
      this.snackBar.open('成交价已更正，原分摊失效，需重算', '关闭', { duration: 2200 })
      this.editing = null
    })
  }

  confirmReturn() {
    if (!this.editing || !this.editing.reason.trim()) return
    const { batch, reason } = this.editing
    this.service.returnSalvage(batch.id, reason.trim()).subscribe(() => {
      this.store.dispatch(salvageReturn({ batchId: batch.id, reason: reason.trim() }))
      this.snackBar.open('残值已退回，原分摊失效，需重算', '关闭', { duration: 2200 })
      this.editing = null
    })
  }

  startQuoteChange(item: { itemId: string; category: string }) {
    this.quoteChangeItem = item
    this.quoteChangeReason = ''
    this.editing = null
  }

  confirmQuoteChange(claim: ClaimCase) {
    if (!this.quoteChangeItem || !this.quoteChangeReason.trim()) return
    const itemId = this.quoteChangeItem.itemId
    const reason = this.quoteChangeReason.trim()
    this.service.quoteChanged(claim.id, itemId, reason).subscribe(() => {
      this.store.dispatch(salvageQuoteChanged({ claimId: claim.id, itemId, reason }))
      this.snackBar.open('科目报价已变化，原分摊失效，需重算', '关闭', { duration: 2200 })
      this.quoteChangeItem = null
      this.quoteChangeReason = ''
    })
  }

  recalc(claim: ClaimCase) {
    this.service.recalc(claim.id).subscribe(() => {
      this.store.dispatch(salvageRecalc({ claimId: claim.id }))
      this.snackBar.open('分摊已重算', '关闭', { duration: 1800 })
    })
  }

  release(claim: ClaimCase) {
    const blockers = this.blockersSnapshot(claim)
    if (blockers.length) {
      this.snackBar.open(`不能放行：${blockers.join('；')}`, '关闭', { duration: 2800 })
      return
    }
    this.service.release(claim.id).subscribe(() => {
      this.store.dispatch(salvageRelease({ claimId: claim.id }))
      this.snackBar.open('分摊账已放行', '关闭', { duration: 1800 })
    })
  }

  private blockersSnapshot(claim: ClaimCase): string[] {
    const batches = this.latestBucket?.batches ?? []
    const conflicts = this.latestBucket?.conflicts ?? []
    return releaseBlockers(claim.id, batches, conflicts)
  }

  adjudicate(conflict: BatchConflict, decision: '确认' | '驳回') {
    this.service.adjudicate(conflict.id, decision).subscribe(() => {
      this.store.dispatch(salvageAdjudicate({ conflictId: conflict.id, decision }))
      this.snackBar.open(decision === '确认' ? '已确认留冲突，后到金额继续留持' : '已驳回后到批次', '关闭', { duration: 2000 })
    })
  }

  recover(draft: LocalBatchDraft) {
    this.store.dispatch(salvageRecoverDraft({ draftId: draft.id }))
    this.snackBar.open('本地批次已恢复并提交，等待复核', '关闭', { duration: 2000 })
  }

  discard(draft: LocalBatchDraft) {
    this.store.dispatch(salvageDiscardDraft({ draftId: draft.id }))
    this.snackBar.open('本地草稿已删除', '关闭', { duration: 1400 })
  }

  backfill(claim: ClaimCase) {
    const items = claim.lossItems.map((it) => ({ itemId: it.id, category: it.category, salvage: it.salvage }))
    this.service.backfill(claim.id, claim.lossItems).subscribe(() => {
      this.store.dispatch(salvageBackfill({ claimId: claim.id, items }))
      this.snackBar.open('已按残值补一版分摊依据', '关闭', { duration: 2000 })
    })
  }

  statusTone(status: string): 'default' | 'warn' | 'good' {
    if (status === '已冲减') return 'good'
    if (status === '待复核' || status === '已失效' || status === '已退回') return 'warn'
    return 'default'
  }
}
