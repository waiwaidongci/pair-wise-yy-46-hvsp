import { Component, Input } from '@angular/core'
import { CommonModule, CurrencyPipe, PercentPipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatExpansionModule } from '@angular/material/expansion'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MatTableModule } from '@angular/material/table'
import { HttpErrorResponse } from '@angular/common/http'
import { Store } from '@ngrx/store'
import { StatusChipComponent } from '../shared/status-chip.component'
import type { ClaimCase } from '../core/models'
import { deriveBatch, entryStatus } from './allocation.engine'
import { SalvageActionsService } from './salvage-actions.service'
import { setSalvageToast, type RootState } from './salvage.store'
import type { SalvageBatch } from './models'

@Component({
  selector: 'app-batch-card',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CurrencyPipe,
    PercentPipe,
    MatButtonModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatTableModule,
    StatusChipComponent,
  ],
  template: `
    <article class="batch-card panel" [class.blocked]="derived.blockerLabel">
      <header class="batch-head">
        <div>
          <div class="title-row">
            <mat-icon>inventory_2</mat-icon>
            <strong>{{ batch.batchNo }}</strong>
            <app-status-chip
              [label]="batch.sourceTag"
              [tone]="batch.sourceTag === '按残值补录' ? 'warn' : 'default'"
            />
            <app-status-chip
              *ngIf="derived.blockerLabel; else effectiveTag"
              [label]="statusLabel"
              tone="warn"
            />
            <ng-template #effectiveTag><app-status-chip label="冲减生效中" tone="good" /></ng-template>
          </div>
          <small>
            经办 {{ batch.submittedBy }} · {{ batch.submittedAt }}
            <ng-container *ngIf="batch.reviewedBy"> · 复核 {{ batch.reviewedBy }} · {{ batch.reviewedAt }}</ng-container>
          </small>
        </div>
        <div class="deal">
          <span>成交额</span>
          <strong>{{ batch.dealAmount | currency: 'CNY':'symbol':'1.0-0' }}</strong>
          <small *ngIf="batch.returnedAmount > 0">已退回 {{ batch.returnedAmount | currency: 'CNY':'symbol':'1.0-0' }} · 净额 {{ batch.dealAmount - batch.returnedAmount | currency: 'CNY':'symbol':'1.0-0' }}</small>
        </div>
      </header>

      <div class="blocker-banner" *ngIf="derived.blockerLabel">
        <mat-icon>block</mat-icon>
        <div>
          <strong>{{ derived.blockerLabel }}</strong>
          <p *ngFor="let reason of derived.staleReasons">· {{ reason.detail }}</p>
        </div>
      </div>

      <div class="conflict-box" *ngIf="derived.activeConflict">
        <mat-icon>bolt</mat-icon>
        <div>
          <strong>并发冲突金额</strong>
          <p *ngFor="let conflict of batch.conflicts">
            <ng-container *ngIf="!conflict.resolvedBy; else resolved">
              {{ conflict.operator }} 后到提交 {{ conflict.dealAmount | currency: 'CNY':'symbol':'1.0-0' }}（{{ conflict.at }}）：{{ conflict.note }}
            </ng-container>
            <ng-template #resolved>
              <span class="muted">{{ conflict.operator }} 的 {{ conflict.dealAmount | currency: 'CNY':'symbol':'1.0-0' }} 已由 {{ conflict.resolvedBy }} 处理：{{ conflict.resolution }}</span>
            </ng-template>
          </p>
        </div>
      </div>

      <div class="table-wrap">
        <table mat-table [dataSource]="batch.entries">
          <ng-container matColumnDef="category">
            <th mat-header-cell *matHeaderCellDef>来源科目</th>
            <td mat-cell *matCellDef="let entry">{{ entry.category }}</td>
          </ng-container>
          <ng-container matColumnDef="weight">
            <th mat-header-cell *matHeaderCellDef>残值占比</th>
            <td mat-cell *matCellDef="let entry">{{ entry.weight | percent: '1.0-2' }}</td>
          </ng-container>
          <ng-container matColumnDef="amount">
            <th mat-header-cell *matHeaderCellDef>分摊金额</th>
            <td mat-cell *matCellDef="let entry">
              <strong>{{ entry.allocatedAmount | currency: 'CNY':'symbol':'1.0-0' }}</strong>
              <small *ngIf="entry.allocatedAmount === 0">退回后净额为 0</small>
            </td>
          </ng-container>
          <ng-container matColumnDef="basis">
            <th mat-header-cell *matHeaderCellDef>分摊依据</th>
            <td mat-cell *matCellDef="let entry">
              成交价 {{ entry.basisDealAmount.toLocaleString('zh-CN') }} · 退回 {{ entry.basisReturnedAmount.toLocaleString('zh-CN') }} · 报价 V{{ entry.basisQuoteVersion }}
              <small>{{ entry.computedAt }} · V{{ entry.version }}</small>
            </td>
          </ng-container>
          <ng-container matColumnDef="status">
            <th mat-header-cell *matHeaderCellDef>状态</th>
            <td mat-cell *matCellDef="let entry">
              <app-status-chip
                [label]="entryStatus(entry, batch, claim)"
                [tone]="entryStatus(entry, batch, claim) === '生效中' ? 'good' : 'warn'"
              />
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="entryColumns"></tr>
          <tr mat-row *matRowDef="let row; columns: entryColumns"></tr>
        </table>
      </div>

      <mat-accordion *ngIf="batch.entryHistory.length > 0">
        <mat-expansion-panel>
          <mat-expansion-panel-header>
            <mat-panel-title>历史分摊版本（{{ batch.entryHistory.length }} 条，已失效留痕）</mat-panel-title>
          </mat-expansion-panel-header>
          <div class="history-line" *ngFor="let entry of batch.entryHistory">
            <app-status-chip label="已失效" tone="warn" />
            <span>{{ entry.category }} · V{{ entry.version }}</span>
            <span class="muted">{{ entry.allocatedAmount | currency: 'CNY':'symbol':'1.0-0' }}（依据：成交价 {{ entry.basisDealAmount.toLocaleString('zh-CN') }} / 报价 V{{ entry.basisQuoteVersion }}）· {{ entry.computedAt }}</span>
          </div>
        </mat-expansion-panel>
      </mat-accordion>

      <div class="batch-actions">
        <button
          *ngIf="!batch.reviewedBy && !derived.activeConflict"
          mat-flat-button
          color="primary"
          (click)="openInline('review')"
        >
          <mat-icon>verified</mat-icon> 复核通过并冲减
        </button>
        <button
          *ngIf="derived.isStale"
          mat-flat-button
          color="primary"
          (click)="openInline('reallocate')"
        >
          <mat-icon>restart_alt</mat-icon> 按新依据重新分摊
        </button>
        <button mat-stroked-button (click)="openInline('correction')">
          <mat-icon>edit</mat-icon> 成交价更正
        </button>
        <button mat-stroked-button (click)="openInline('return')">
          <mat-icon>undo</mat-icon> 残值退回
        </button>
        <button *ngIf="derived.activeConflict" mat-stroked-button color="warn" (click)="openInline('conflict')">
          <mat-icon>handyman</mat-icon> 处理冲突金额
        </button>
      </div>

      <div class="inline-form" *ngIf="inlineKind">
        <ng-container [ngSwitch]="inlineKind">
          <ng-container *ngSwitchCase="'review'">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>复核人</mat-label>
              <input matInput [(ngModel)]="reviewer" placeholder="如：韩薇 / 残值复核" />
            </mat-form-field>
            <button mat-flat-button color="primary" [disabled]="!reviewer.trim()" (click)="doReview()">确认复核</button>
          </ng-container>

          <ng-container *ngSwitchCase="'reallocate'">
            <p class="form-note">系统将按当前成交额、退回额与最新报价重新计算分摊，原分录保留为失效版本，重算后需复核确认。</p>
            <button mat-flat-button color="primary" (click)="doReallocate()">立即重算</button>
          </ng-container>

          <ng-container *ngSwitchCase="'correction'">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>更正后成交价</mat-label>
              <input matInput type="number" [(ngModel)]="correctAmount" />
            </mat-form-field>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>经办人</mat-label>
              <input matInput [(ngModel)]="reviewer" placeholder="姓名 / 岗位" />
            </mat-form-field>
            <button
              mat-flat-button
              color="primary"
              [disabled]="!reviewer.trim() || correctAmount === null || correctAmount < 0"
              (click)="doCorrect()"
            >
              更正并重算
            </button>
          </ng-container>

          <ng-container *ngSwitchCase="'return'">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>本次退回金额（上限 {{ batch.dealAmount - batch.returnedAmount }}）</mat-label>
              <input matInput type="number" [(ngModel)]="returnAmount" />
            </mat-form-field>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>经办人</mat-label>
              <input matInput [(ngModel)]="reviewer" placeholder="姓名 / 岗位" />
            </mat-form-field>
            <button
              mat-flat-button
              color="primary"
              [disabled]="!reviewer.trim() || !returnAmount || returnAmount <= 0"
              (click)="doReturn()"
            >
              登记退回并重算
            </button>
          </ng-container>

          <ng-container *ngSwitchCase="'conflict'">
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="wide">
              <mat-label>冲突处理说明（后到金额作废 / 补录为新批次）</mat-label>
              <input matInput [(ngModel)]="resolution" />
            </mat-form-field>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>处理人</mat-label>
              <input matInput [(ngModel)]="reviewer" placeholder="姓名 / 岗位" />
            </mat-form-field>
            <button mat-flat-button color="primary" [disabled]="!reviewer.trim() || !resolution.trim()" (click)="doResolve()">
              解除冲突挂起
            </button>
          </ng-container>
        </ng-container>
        <button mat-button (click)="inlineKind = ''">取消</button>
      </div>
    </article>
  `,
  styles: [`
    .batch-card { padding: 14px 16px; display: grid; gap: 12px; }
    .batch-card.blocked { border-left: 3px solid #ce743e; }
    .batch-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .title-row mat-icon { color: #2f7080; }
    .batch-head small { display: block; margin-top: 5px; color: #7c8890; font-size: 11px; }
    .deal { text-align: right; white-space: nowrap; }
    .deal span { display: block; color: #76828b; font-size: 11px; }
    .deal strong { display: block; font-size: 20px; color: #164757; }
    .deal small { display: block; margin-top: 3px; color: #b05d2c; font-size: 10px; }
    .blocker-banner, .conflict-box { display: flex; gap: 9px; padding: 10px 12px; border-radius: 7px; font-size: 12px; }
    .blocker-banner { color: #763f20; background: #fff3e8; border-left: 3px solid #ce743e; }
    .blocker-banner p { margin: 3px 0 0; }
    .conflict-box { color: #6f4313; background: #fff7e0; border-left: 3px solid #d39a2c; }
    .conflict-box p { margin: 4px 0 0; line-height: 1.5; }
    .muted { color: #7c8890; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; min-width: 640px; }
    td small { display: block; margin-top: 4px; color: #8a969e; font-size: 10px; }
    .history-line { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 11px; color: #5b6972; }
    .batch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .inline-form { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px; background: #f4f7f8; border-left: 3px solid #277b89; border-radius: 6px; }
    .inline-form mat-form-field { width: 210px; }
    .inline-form mat-form-field.wide { width: 320px; }
    .form-note { flex-basis: 100%; margin: 0; color: #5b6972; font-size: 12px; }
  `],
})
export class BatchCardComponent {
  @Input({ required: true }) batch!: SalvageBatch
  @Input({ required: true }) claim?: ClaimCase

  readonly entryColumns = ['category', 'weight', 'amount', 'basis', 'status']
  readonly defaultReviewer = '韩薇 / 残值复核'

  reviewer = this.defaultReviewer
  correctAmount: number | null = null
  returnAmount: number | null = null
  resolution = ''
  inlineKind: '' | 'review' | 'reallocate' | 'correction' | 'return' | 'conflict' = ''

  constructor(
    private readonly actions: SalvageActionsService,
    private readonly store: Store<RootState>,
    private readonly snackBar: MatSnackBar,
  ) {}

  get derived() {
    return deriveBatch(this.batch, this.claim)
  }

  get statusLabel(): string {
    if (this.derived.activeConflict) return '冲突挂起'
    if (!this.batch.reviewedBy) return '待复核·不冲减'
    if (this.batch.reviewStale) return '待复核确认'
    if (this.derived.isStale) return '已失效·待重算'
    return '冲减生效中'
  }

  entryStatus = entryStatus

  openInline(kind: Extract<BatchCardComponent['inlineKind'], string>) {
    this.inlineKind = kind
    this.reviewer = this.defaultReviewer
    this.correctAmount = this.batch.dealAmount
    this.returnAmount = null
    this.resolution = ''
  }

  private handleError(error: unknown) {
    const message = error instanceof HttpErrorResponse ? error.error?.message ?? error.message : '操作失败'
    this.store.dispatch(setSalvageToast({ message }))
    this.snackBar.open(message, '关闭', { duration: 2600 })
  }

  doReview() {
    const reviewer = this.reviewer.trim()
    if (!reviewer) return
    this.actions.review(this.batch.id, { reviewer }).subscribe({
      next: () => {
        this.inlineKind = ''
        this.snackBar.open('复核通过，回收款开始冲减赔付方案', '关闭', { duration: 2200 })
      },
      error: (error) => this.handleError(error),
    })
  }

  doReallocate() {
    this.actions.reallocate(this.batch.id, this.reviewer.trim() || '残值经办').subscribe({
      next: () => {
        this.inlineKind = ''
        this.snackBar.open('已按新依据重算，旧分录失效留痕；复核前不得放行', '关闭', { duration: 2600 })
      },
      error: (error) => this.handleError(error),
    })
  }

  doCorrect() {
    const operator = this.reviewer.trim()
    if (!operator || this.correctAmount === null) return
    this.actions.correct(this.batch.id, { dealAmount: Number(this.correctAmount), operator }).subscribe({
      next: () => {
        this.inlineKind = ''
        this.snackBar.open('成交价已更正，原分摊失效并重算，等待复核', '关闭', { duration: 2600 })
      },
      error: (error) => this.handleError(error),
    })
  }

  doReturn() {
    const operator = this.reviewer.trim()
    if (!operator || !this.returnAmount) return
    this.actions.returnSalvage(this.batch.id, { amount: Number(this.returnAmount), operator }).subscribe({
      next: () => {
        this.inlineKind = ''
        this.snackBar.open('残值退回已登记，按净额重算并等待复核', '关闭', { duration: 2600 })
      },
      error: (error) => this.handleError(error),
    })
  }

  doResolve() {
    const operator = this.reviewer.trim()
    if (!operator || !this.resolution.trim()) return
    this.actions.resolveConflict(this.batch.id, { operator, resolution: this.resolution.trim() }).subscribe({
      next: () => {
        this.inlineKind = ''
        this.snackBar.open('冲突金额已处理，方案阻断解除（如仍有待复核/失效批次则继续阻断）', '关闭', { duration: 2600 })
      },
      error: (error) => this.handleError(error),
    })
  }
}
