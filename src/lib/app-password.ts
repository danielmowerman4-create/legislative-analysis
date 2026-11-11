export type AppPasswordShape = "letters16" | "apple";

const SHAPES: Record<AppPasswordShape, RegExp> = {
  letters16: /^[a-z]{16}$/i,
  apple: /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/i,
};

export function cleanAppPassword(shape: AppPasswordShape | null, typed: string) {
  return shape === "letters16" ? typed.replace(/\s+/g, "") : typed.trim();
}

// Catches a regular email password before it is ever sent to the mail service.
export function appPasswordProblem(label: string, shape: AppPasswordShape | null, typed: string): string | null {
  if (!shape || SHAPES[shape].test(cleanAppPassword(shape, typed))) return null;
  const looks = shape === "apple" ? "four groups of four letters" : "16 letters";
  return `That is not a ${label} app password. An app password is ${looks} that ${label} makes for this app. Your regular ${label} password does not work here.`;
}
