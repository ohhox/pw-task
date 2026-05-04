// ─── SKELETON LOADERS ──────────────────────────────────────────────────────
// Shimmer placeholders shown while data loads. Replaces blank screens.

export interface SkeletonOpts {
  width?: string;   // e.g., '100%', '200px', '60%'
  height?: string;  // e.g., '14px', '40px'
  radius?: string;  // border-radius
  className?: string;
}

export function skeleton(opts: SkeletonOpts = {}): string {
  const { width = '100%', height = '14px', radius = '4px', className = '' } = opts;
  return `<span class="skeleton ${className}" style="display:inline-block;width:${width};height:${height};border-radius:${radius}"></span>`;
}

/** Skeleton for a task row in list view */
export function taskRowSkeleton(): string {
  return `
    <div class="task-row task-row--skeleton">
      ${skeleton({ width: '14px', height: '14px', radius: '50%' })}
      ${skeleton({ width: '60%', height: '14px' })}
      <span style="flex:1"></span>
      ${skeleton({ width: '60px', height: '20px', radius: '99px' })}
    </div>
  `;
}

/** Render multiple task row skeletons */
export function taskListSkeleton(count = 5): string {
  return Array(count).fill(0).map(taskRowSkeleton).join('');
}

/** Skeleton for project card / sidebar item */
export function projectItemSkeleton(): string {
  return `
    <div class="project-item project-item--skeleton">
      ${skeleton({ width: '8px', height: '8px', radius: '50%' })}
      <div style="flex:1">
        ${skeleton({ width: '70%', height: '13px' })}
        <div style="height:4px"></div>
        ${skeleton({ width: '40%', height: '11px' })}
      </div>
    </div>
  `;
}
