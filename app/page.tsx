import Link from "next/link";

/** The front door: one line, one way in. */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6 px-6 py-16 text-slate-700">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        ade<span className="text-sky-500">-lens</span>
      </h1>
      <p className="text-lg">
        A Power BI report with an agent beside it that sees what you see, answers from the model as you, and
        can filter, change page or open another report when you ask.
      </p>
      <div>
        <Link
          href="/app/lens"
          className="inline-block rounded-md bg-sky-600 px-4 py-2 font-semibold text-white hover:bg-sky-500"
        >
          Open Report Lens
        </Link>
      </div>
    </main>
  );
}
