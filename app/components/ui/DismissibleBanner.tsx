import { useEffect, useRef } from "react";

// `<s-banner dismissible>` emits a native `dismiss` event when the merchant
// closes it. React 18 cannot deliver that event:
//
//   * `dismiss` is not one of React's registered event names, so `onDismiss` is
//     never wired to a listener; React falls through to writing it as a DOM
//     attribute and then drops it, because the value is a function.
//   * React 19 added custom-element property/event support. Until this app is
//     on 19, the only way to hear the event is to attach the listener to the
//     element ourselves.
//
// Every dismissible banner in the app goes through this component so the
// workaround lives in exactly one place and disappears in one edit after a
// React 19 upgrade.

type BannerProps = React.ComponentProps<"s-banner">;

export function DismissibleBanner({
  onDismiss,
  children,
  ...rest
}: Omit<BannerProps, "onDismiss" | "dismissible"> & { onDismiss: () => void }) {
  const ref = useRef<React.ComponentRef<"s-banner">>(null);
  // Held in a ref so the listener is attached once and never goes stale.
  const latest = useRef(onDismiss);
  latest.current = onDismiss;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handle = () => latest.current();
    el.addEventListener("dismiss", handle);
    return () => el.removeEventListener("dismiss", handle);
  }, []);

  return (
    <s-banner ref={ref} dismissible {...rest}>
      {children}
    </s-banner>
  );
}
