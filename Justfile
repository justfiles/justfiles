restart:
  pnpm run build:apps
  pnpm --filter @justfiles/quay run build
  pnpm --filter @justfiles/quay run reseed
  pkill -f Quay.app/Contents/MacOS/Quay 2>/dev/null; while pgrep -f Quay.app/Contents/MacOS/Quay >/dev/null; do sleep 0.1; done
  open -n apps/quay/native/Quay.app
