import { useLingui } from "@lingui/react/macro";
import orkIcon from "../../public/icon-192.png?inline";

/** A whole-page wait for startup and navigation between workspaces. */
export function PageLoading(props: React.ComponentPropsWithoutRef<"div">) {
  const { t } = useLingui();
  return (
    <div className="grid h-full place-items-center bg-background" {...props}>
      <div role="status" aria-live="polite" className="grid justify-items-center gap-4">
        <img src={orkIcon} alt="" width="80" height="80" className="size-20 rounded-2xl" />
        <span className="text-sm text-muted-foreground">{t`Loading…`}</span>
      </div>
    </div>
  );
}
