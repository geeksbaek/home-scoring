import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "@/lib/utils";

function Slider({
  className,
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  ...props
}: SliderPrimitive.Root.Props<readonly number[]> & { className?: string }) {
  const arr = Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max];
  return (
    <SliderPrimitive.Root
      value={value as readonly number[] | undefined}
      defaultValue={defaultValue as readonly number[] | undefined}
      min={min}
      max={max}
      step={step}
      onValueChange={onValueChange}
      {...props}
    >
      <SliderPrimitive.Control className={cn("relative flex w-full touch-none select-none items-center", className)}>
        <SliderPrimitive.Track className="bg-muted relative grow rounded-full h-1.5">
          <SliderPrimitive.Indicator className="bg-primary absolute h-full rounded-full" />
        </SliderPrimitive.Track>
        {arr.map((_, i) => (
          <SliderPrimitive.Thumb
            key={i}
            index={i}
            className="block h-4 w-4 rounded-full border-2 border-primary bg-background shadow ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
