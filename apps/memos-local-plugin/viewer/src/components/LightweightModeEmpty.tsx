import { Icon, type IconName } from "./Icon";

export function LightweightModeEmpty({
  icon,
  message,
}: {
  icon: IconName;
  message: string;
}) {
  return (
    <div class="empty">
      <div class="empty__icon">
        <Icon name={icon} size={22} />
      </div>
      <div class="empty__title">{message}</div>
    </div>
  );
}
