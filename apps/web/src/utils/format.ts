export const formatBytes = (value: number | null) => {
  if (value == null) {
    return 'unknown size';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size > 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

export function formatRouterStatus(status: string): string {
  if (status === 'stopped') {
    return 'router stopped';
  }
  return status.replace(/_/g, ' ');
}

export function routerStatusColor(status: string): 'green' | 'yellow' | 'red' | 'blue' {
  if (status === 'loaded' || status === 'sleeping') {
    return 'green';
  }
  if (status === 'failed') {
    return 'red';
  }
  if (status === 'loading' || status === 'unloaded') {
    return 'yellow';
  }
  return 'blue';
}
