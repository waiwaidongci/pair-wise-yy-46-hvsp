import { Component } from '@angular/core'
import { CommonModule, CurrencyPipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatCardModule } from '@angular/material/card'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatStepperModule } from '@angular/material/stepper'
import { MatTableModule } from '@angular/material/table'
import { MatSnackBar } from '@angular/material/snack-bar'
import { Store } from '@ngrx/store'
import { combineLatest, map, Observable } from 'rxjs'
import { ClaimsService } from '../core/claims.service'
import type { ClaimCase } from '../core/models'
import { selectSelectedClaim, updateClaim } from '../core/claims.store'
import { StatusChipComponent } from '../shared/status-chip.component'
import { buildPlanView, releaseBlockers } from '../salvage/allocation.engine'
import { selectAllBatches, selectReleasedPlans, releasePlan, type RootState } from '../salvage/salvage.store'
import type { PayoutPlanKind, ReleasedPlan, SalvageBatch } from '../salvage/models'

type ReviewModel = {
  claim: ClaimCase
  batches: SalvageBatch[]
  planView: ReturnType<typeof buildPlanView>
  blockers: string[]
  released: Partial<Record<PayoutPlanKind, ReleasedPlan>>
}

@Component({
  selector: 'app-review-page',
  standalone: true,
  imports: [CommonModule, CurrencyPipe, FormsModule, MatButtonModule, MatCardModule, MatFormFieldModule, MatIconModule, MatInputModule, MatStepperModule, MatTableModule, StatusChipComponent],
  template: `
    <section class="page" *ngIf="model$ | async as model">
      <div class="page-head">
        <div>
          <p class="eyebrow">RESERVE APPROVAL / 准备金审批</p>
          <h1>多级会签与赔付方案比较</h1>
          <p class="muted">赔付金额与残值分摊账实时对账；未复核或已失效的回收款一律不得冲减放行。</p>
        </div>
        <span class="reserve">申请准备金 {{ model.claim.reserve | currency: 'CNY':'symbol':'1.0-0' }}</span>
      </div>

      <div class="review-grid">
        <section class="panel">
          <div class="panel-head"><h3>会签流程</h3><app-status-chip [label]="model.claim.status" [tone]="model.claim.status === '退回补件' ? 'warn' : 'good'" /></div>
          <mat-stepper orientation="vertical" [linear]="false" class="approval-stepper">
            <mat-step *ngFor="let step of model.claim.approvals; let index = index" [completed]="step.status === '已通过'">
              <ng-template matStepLabel>
                <strong>{{ step.role }}</strong>
                <span class="threshold">触发阈值 {{ step.threshold | currency: 'CNY':'symbol':'1.0-0' }}</span>
              </ng-template>
              <div class="step-body">
                <p>{{ step.comment || (step.status === '待处理' ? '等待当前审核人处理。' : step.status + '。') }}</p>
                <small *ngIf="step.operator">{{ step.operator }} · {{ step.completedAt }}</small>
                <div class="step-actions" *ngIf="step.status === '待处理'">
                  <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>审批意见</mat-label><input matInput [(ngModel)]="comments[index]" /></mat-form-field>
                  <button mat-flat-button color="primary" [disabled]="!comments[index]?.trim()" (click)="decide(model.claim.id, step.role, '已通过', index)">通过</button>
                  <button mat-stroked-button color="warn" [disabled]="!comments[index]?.trim()" (click)="decide(model.claim.id, step.role, '退回补件', index)">退回补件</button>
                </div>
              </div>
            </mat-step>
          </mat-stepper>
        </section>

        <aside>
          <section class="panel">
            <div class="panel-head">
              <h3>赔付方案对比</h3>
              <span class="muted">已扣生效冲减 {{ model.planView.totalDeduction | currency: 'CNY':'symbol':'1.0-0' }}</span>
            </div>
            <div class="table-wrap ledger-table">
              <table mat-table [dataSource]="model.planView.rows">
                <ng-container matColumnDef="category">
                  <th mat-header-cell *matHeaderCellDef>科目</th>
                  <td mat-cell *matCellDef="let row">{{ row.category }}<small *ngIf="row.disputed">争议项</small></td>
                </ng-container>
                <ng-container matColumnDef="deduction">
                  <th mat-header-cell *matHeaderCellDef>生效冲减</th>
                  <td mat-cell *matCellDef="let row" [class.zero-deduct]="row.salvageDeduction === 0">
                    {{ row.salvageDeduction | currency: 'CNY':'symbol':'1.0-0' }}
                  </td>
                </ng-container>
                <ng-container matColumnDef="net">
                  <th mat-header-cell *matHeaderCellDef>责任后净额</th>
                  <td mat-cell *matCellDef="let row">{{ row.contributionA | currency: 'CNY':'symbol':'1.0-0' }}</td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="ledgerColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: ledgerColumns"></tr>
              </table>
            </div>
            <div class="plans">
              <mat-card appearance="outlined" [class.released]="model.released['A']">
                <span>方案 A · 现状评估</span>
                <strong>{{ model.planView.planA | currency: 'CNY':'symbol':'1.0-0' }}</strong>
                <p>按生效分摊冲减后的责任净额计入免赔。</p>
                <ng-container *ngIf="model.released['A'] as released; else releaseA">
                  <app-status-chip label="已放行" tone="good" />
                  <small>{{ released.by }} · {{ released.at }}（放行时 {{ released.amountSnapshot | currency: 'CNY':'symbol':'1.0-0' }}）</small>
                </ng-container>
                <ng-template #releaseA>
                  <button mat-flat-button color="primary" [disabled]="model.blockers.length > 0" (click)="release(model, 'A')">
                    <mat-icon>send_money</mat-icon> 放行方案 A
                  </button>
                </ng-template>
              </mat-card>
              <mat-card appearance="outlined" class="recommended" [class.released]="model.released['B']">
                <span>方案 B · 核减待证部分</span>
                <strong>{{ model.planView.planB | currency: 'CNY':'symbol':'1.0-0' }}</strong>
                <p>争议科目每项暂扣 72,000 元，证据补齐后追加。</p>
                <ng-container *ngIf="model.released['B'] as released; else releaseB">
                  <app-status-chip label="已放行" tone="good" />
                  <small>{{ released.by }} · {{ released.at }}（放行时 {{ released.amountSnapshot | currency: 'CNY':'symbol':'1.0-0' }}）</small>
                </ng-container>
                <ng-template #releaseB>
                  <button mat-flat-button color="primary" [disabled]="model.blockers.length > 0" (click)="release(model, 'B')">
                    <mat-icon>send_money</mat-icon> 放行方案 B
                  </button>
                </ng-template>
              </mat-card>
            </div>

            <div class="release-box" [class.ok]="model.blockers.length === 0">
              <mat-icon>{{ model.blockers.length > 0 ? 'lock' : 'lock_open' }}</mat-icon>
              <div>
                <strong>{{ model.blockers.length > 0 ? '方案冻结，存在 ' + model.blockers.length + ' 项残值阻断' : '残值分摊账与赔付方案已对齐，可放行' }}</strong>
                <p *ngFor="let blocker of model.blockers">· {{ blocker }}</p>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>争议项定位</h3><span class="muted">{{ disputedCount(model.claim) }} 项</span></div>
            <div class="disputes">
              <div *ngFor="let item of model.claim.lossItems" [class.disputed]="item.disputed">
                <mat-icon>{{ item.disputed ? 'report_problem' : 'check_circle' }}</mat-icon>
                <div><strong>{{ item.category }} · {{ item.description }}</strong><p>{{ item.disputed ? '存在证据差异，审批意见不能覆盖原始查勘记录。' : '材料一致，可纳入当前方案。' }}</p></div>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </section>
  `,
  styles: [`
    .reserve { padding: 10px 14px; border-left: 3px solid #2f8191; background: #eaf4f5; color: #175866; font-weight: 800; }
    .review-grid { display: grid; grid-template-columns: minmax(0,1fr) 380px; gap: 14px; align-items: start; }
    .approval-stepper { padding: 18px 22px 22px 8px; background: transparent; }
    mat-step strong, mat-step .threshold { display: block; }
    .threshold { margin-top: 3px; color: #78858d; font-size: 10px; }
    .step-body { padding: 4px 0 16px; }
    .step-body p { margin: 0 0 6px; color: #58666f; }
    .step-body small { color: #869198; }
    .step-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .step-actions mat-form-field { flex: 1; min-width: 240px; }
    aside { display: grid; gap: 14px; }
    .ledger-table { padding: 8px 12px 0; }
    .zero-deduct { color: #98a2aa; }
    td small { display: block; color: #8a969e; font-size: 10px; }
    .plans { display: grid; gap: 10px; padding: 14px; }
    .plans mat-card { padding: 14px; }
    .plans .recommended { border-color: #39828b; background: #f0f8f8; }
    .plans .released { border-color: #3f9a72; background: #f1f8f4; }
    .plans span, .plans p { display: block; color: #69767e; font-size: 12px; }
    .plans strong { display: block; margin: 7px 0; color: #184855; font-size: 22px; }
    .plans small { display: block; margin-top: 8px; color: #7c8890; font-size: 10px; }
    .release-box { display: flex; gap: 9px; margin: 0 14px 14px; padding: 11px 12px; border-radius: 7px; font-size: 12px; color: #763f20; background: #fff3e8; border-left: 3px solid #ce743e; }
    .release-box.ok { color: #246049; background: #eaf6ef; border-left-color: #3f9a72; }
    .release-box p { margin: 3px 0 0; }
    .disputes { padding: 6px 14px 14px; }
    .disputes > div { display: flex; gap: 9px; padding: 10px 0; border-bottom: 1px solid #edf0f2; color: #437360; }
    .disputes > div.disputed { color: #b55a2e; }
    .disputes strong { font-size: 12px; }
    .disputes p { margin: 5px 0 0; color: #6d7981; font-size: 11px; line-height: 1.5; }
    @media (max-width: 1050px) { .review-grid { grid-template-columns: 1fr; } }
  `],
})
export class ReviewPageComponent {
  readonly ledgerColumns = ['category', 'deduction', 'net']
  comments: Record<number, string> = {}

  model$: Observable<ReviewModel>

  constructor(
    private readonly store: Store<RootState>,
    private readonly service: ClaimsService,
    private readonly snackBar: MatSnackBar,
  ) {
    this.model$ = combineLatest([
      this.store.select(selectSelectedClaim),
      this.store.select(selectAllBatches),
      this.store.select(selectReleasedPlans),
    ]).pipe(
      map(([claim, batches, releasedMap]) => {
        const claimBatches = batches.filter((batch) => batch.claimId === claim.id)
        return {
          claim,
          batches: claimBatches,
          planView: buildPlanView(claimBatches, claim),
          blockers: releaseBlockers(claimBatches, claim),
          released: releasedMap[claim.id] ?? {},
        }
      }),
    )
  }

  disputedCount(claim: ClaimCase) {
    return claim.lossItems.filter((item) => item.disputed).length
  }

  release(model: ReviewModel, kind: PayoutPlanKind) {
    if (model.blockers.length > 0) {
      this.snackBar.open('仍有残值阻断项，不能放行', '关闭', { duration: 2400 })
      return
    }
    const amount = kind === 'A' ? model.planView.planA : model.planView.planB
    this.store.dispatch(
      releasePlan({
        claimId: model.claim.id,
        kind,
        released: { at: new Date().toLocaleString('zh-CN', { hour12: false }), by: '当前审批人', amountSnapshot: amount },
      }),
    )
    this.snackBar.open(`方案 ${kind} 已放行，赔付金额与分摊账核对一致`, '关闭', { duration: 2600 })
  }

  decide(claimId: string, role: string, result: string, index: number) {
    const comment = this.comments[index]?.trim()
    if (!comment) return
    this.service.approve(claimId, { role, result, comment }).subscribe(() => {
      this.store.select(selectSelectedClaim).subscribe((claim) => this.store.dispatch(updateClaim({ claim: structuredClone(claim) })))
      this.snackBar.open(result === '已通过' ? '会签通过，已流转至下一级' : '案件已退回补件，原始记录未修改', '关闭', { duration: 2200 })
      this.comments[index] = ''
    })
  }
}
