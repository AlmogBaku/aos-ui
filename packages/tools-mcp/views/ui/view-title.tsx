/**
 * A view's own heading. The host card already names the tool and its status,
 * so the view adds only a compact title and an optional line under it.
 */
export function ViewTitle({
  title,
  description,
}: {
  title: string
  description?: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="m-0 text-sm font-medium text-pretty text-foreground">
        {title}
      </h2>
      {description ? (
        <p className="m-0 text-xs text-pretty text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  )
}
