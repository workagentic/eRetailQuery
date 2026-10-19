import { signOutAction } from '../(app)/actions';

export default function NoAccessPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">No demo access</h1>
      <p className="text-sm text-muted-foreground">
        You are signed in, but this account is not a member of any business yet. Ask the person who
        gave you the demo to add you, then sign in again.
      </p>
      <form action={signOutAction}>
        <button type="submit" className="rounded-md border border-border px-3 py-2 text-sm">
          Sign out
        </button>
      </form>
    </main>
  );
}
