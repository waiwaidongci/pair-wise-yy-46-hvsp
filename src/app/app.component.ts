import { Component, OnInit } from '@angular/core'
import { CommonModule } from '@angular/common'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { MatSidenavModule } from '@angular/material/sidenav'
import { MatToolbarModule } from '@angular/material/toolbar'
import { MatIconModule } from '@angular/material/icon'
import { MatButtonModule } from '@angular/material/button'
import { MatListModule } from '@angular/material/list'
import { MatChipsModule } from '@angular/material/chips'
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar'
import { Store } from '@ngrx/store'
import { ClaimsService } from './core/claims.service'
import { SalvageService } from './salvage/salvage.service'
import { loadClaimsSuccess, selectClaimsState } from './core/claims.store'
import { loadBatches as loadSalvageBatches, selectSalvageState, type RootState } from './salvage/salvage.store'

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatSidenavModule,
    MatToolbarModule,
    MatIconModule,
    MatButtonModule,
    MatListModule,
    MatChipsModule,
    MatSnackBarModule,
  ],
  template: `
    <mat-sidenav-container class="shell">
      <mat-sidenav mode="side" opened class="sidebar" [class.mobile-hidden]="false">
        <div class="brand">
          <div class="brand-mark">财险</div>
          <div>
            <strong>查勘定损中心</strong>
            <small>华东财产险 · 专业工作台</small>
          </div>
        </div>
        <mat-nav-list>
          <a mat-list-item routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">
            <mat-icon matListItemIcon>dashboard</mat-icon>
            <span matListItemTitle>案件总览</span>
          </a>
          <a mat-list-item routerLink="/assessment" routerLinkActive="active">
            <mat-icon matListItemIcon>fact_check</mat-icon>
            <span matListItemTitle>查勘定损</span>
          </a>
          <a mat-list-item routerLink="/salvage" routerLinkActive="active">
            <mat-icon matListItemIcon>inventory_2</mat-icon>
            <span matListItemTitle>残值分摊账</span>
          </a>
          <a mat-list-item routerLink="/review" routerLinkActive="active">
            <mat-icon matListItemIcon>approval</mat-icon>
            <span matListItemTitle>准备金审批</span>
          </a>
          <a mat-list-item routerLink="/audit" routerLinkActive="active">
            <mat-icon matListItemIcon>history</mat-icon>
            <span matListItemTitle>审计与附件</span>
          </a>
        </mat-nav-list>
        <div class="side-note">
          <div class="sync"><i></i> 可恢复草稿已保存</div>
          <small>最后同步 16:42 · 规则版本 2026.09</small>
        </div>
      </mat-sidenav>
      <mat-sidenav-content>
        <mat-toolbar class="mobile-bar">
          <button mat-icon-button (click)="mobileOpen = !mobileOpen"><mat-icon>menu</mat-icon></button>
          <strong>查勘定损中心</strong>
        </mat-toolbar>
        <router-outlet />
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
  styles: [`
    .shell { min-height: 100vh; background: #edf1f3; }
    .sidebar { width: 244px; border: 0; color: #e8f0f3; background: #143443; }
    .brand { display: flex; align-items: center; gap: 11px; padding: 20px 16px; border-bottom: 1px solid rgba(255,255,255,.1); }
    .brand-mark { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid #67a8b5; border-radius: 9px; color: #a6d8df; font-size: 13px; font-weight: 800; }
    .brand strong, .brand small { display: block; }
    .brand strong { font-size: 14px; }
    .brand small { margin-top: 4px; color: #8da5b1; font-size: 10px; }
    mat-nav-list { padding: 16px 10px; }
    mat-nav-list a { margin-bottom: 4px; border-radius: 7px; color: #b9cbd4; }
    mat-nav-list a.active { color: #fff; background: #235062; box-shadow: inset 3px 0 #66b6c2; }
    .side-note { position: absolute; right: 12px; bottom: 14px; left: 12px; padding: 12px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: rgba(255,255,255,.04); }
    .sync { font-size: 11px; font-weight: 700; }
    .sync i { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: #56b989; }
    .side-note small { display: block; margin-top: 6px; color: #92a8b3; font-size: 9px; }
    .mobile-bar { display: none; }
    mat-sidenav-content { min-width: 0; }
    @media (max-width: 820px) {
      .sidebar { display: none; }
      .mobile-bar { display: flex; gap: 8px; background: #143443; color: white; }
    }
  `],
})
export class AppComponent implements OnInit {
  mobileOpen = false

  constructor(
    private readonly service: ClaimsService,
    private readonly salvageService: SalvageService,
    private readonly store: Store<RootState>,
    private readonly snackBar: MatSnackBar,
  ) {}

  ngOnInit() {
    this.service.list({ query: '', status: '', risk: '', page: 1, pageSize: 50 }).subscribe((result) => {
      this.store.dispatch(loadClaimsSuccess({ items: result.items, total: result.total }))
    })
    this.salvageService.list().subscribe((batches) => this.store.dispatch(loadSalvageBatches({ batches })))
    this.store.select(selectClaimsState).subscribe((state) => {
      localStorage.setItem('property-claims-draft-v2', JSON.stringify(state))
      if (state.toast) this.snackBar.open(state.toast, '关闭', { duration: 1800 })
    })
    // 残值状态持久化：本地暂存批次（失败保留可恢复）与已放行方案跨刷新保留
    this.store.select(selectSalvageState).subscribe((state) => {
      localStorage.setItem(
        'property-claims-salvage-v1',
        JSON.stringify({
          batches: state.batches,
          localDrafts: state.localDrafts,
          events: state.events,
          selectedClaimId: state.selectedClaimId,
          released: state.released,
        }),
      )
      if (state.toast) this.snackBar.open(state.toast, '关闭', { duration: 2200 })
    })
  }
}
