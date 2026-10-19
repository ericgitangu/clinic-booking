import Image from "next/image";
import { DECISIONS, DIAGRAM_LABEL, GO_NOTE } from "@/lib/architecture";

const LINK =
  "-my-3 inline-block py-3 underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring";

// Below the fold. The diagram is two pre-rendered SVGs (one per colour scheme), so no Mermaid runs
// in the browser. The images are decorative: the figure carries the label and the table is the
// text alternative.
export function Architecture() {
  return (
    <section aria-labelledby="architecture" className="py-12">
      <h2
        id="architecture"
        className="font-heading text-2xl font-semibold tracking-tight"
      >
        Architecture
      </h2>
      <p className="mt-3 text-base text-muted-foreground">
        On a small screen, scroll the diagram sideways, or{" "}
        <a className={LINK} href="/architecture-light.svg">
          open it full size
        </a>{" "}
        to pinch and zoom. The table below says the same in words.
      </p>
      <div
        role="img"
        aria-label={DIAGRAM_LABEL}
        className="mt-6 overflow-x-auto rounded-md border border-border p-3"
        // The diagram is wide. On a phone it keeps its natural size (18px text) and scrolls inside
        // this box; from md up it is held at 1100px or wider (about 12px text). It never shrinks
        // below that and never widens the page.
        tabIndex={0}
      >
        <div className="min-w-[1647px] md:min-w-[1100px]">
          <Image
            src="/architecture-light.svg"
            alt=""
            width={1647}
            height={1186}
            unoptimized
            className="h-auto w-full dark:hidden"
          />
          <Image
            src="/architecture-dark.svg"
            alt=""
            width={1647}
            height={1186}
            unoptimized
            className="hidden h-auto w-full dark:block"
          />
        </div>
      </div>
      <div className="mt-6 overflow-x-auto" tabIndex={0}>
        <table className="w-full min-w-[640px] border-collapse text-left text-base">
          <caption className="sr-only">
            Each component in the diagram, what I chose and why
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-2 pr-4 font-semibold">
                Component
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Choice
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Why
              </th>
            </tr>
          </thead>
          <tbody>
            {DECISIONS.map((d) => (
              <tr
                key={d.component}
                className="border-b border-border align-top"
              >
                <th scope="row" className="py-3 pr-4 font-medium">
                  {d.component}
                </th>
                <td className="py-3 pr-4">{d.choice}</td>
                <td className="py-3 pr-4 text-muted-foreground">{d.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-6 max-w-[65ch] text-base leading-7">
        {GO_NOTE.statement} {GO_NOTE.reason}
      </p>
    </section>
  );
}
