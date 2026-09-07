/**
 * Every icon in `icons/`, as a value and a type.
 *
 * A union rather than `string` so `<Icon name="Lightbolb" />` fails at compile
 * time instead of 404ing in front of a user. Kept honest by a test in
 * assets.test.ts that compares this list against the directory - without it,
 * adding a PNG and forgetting this file produces a name nobody can use, and
 * renaming one produces a type that lies.
 *
 * Type-only consumers get erased at build, so this file needs no bundling.
 */
export const ICON_NAMES = [
	"Backpack",
	"Basket",
	"Battery",
	"Book",
	"Bottle",
	"Briefcase",
	"CD",
	"Car",
	"Cash",
	"Cash2",
	"CatHead",
	"CatchingNet",
	"ChestTreasure",
	"Chili",
	"Cloud",
	"Coin",
	"Coin2",
	"CookingPot",
	"Cutlery",
	"Document",
	"Download",
	"Enter",
	"Enter2",
	"Exit",
	"Eye",
	"FloppyDisk",
	"Flower",
	"Flower2",
	"FlowerPot",
	"Gamepad",
	"Gamepad2",
	"Gamepad3",
	"Gear",
	"Hammer",
	"Home",
	"Info",
	"Key",
	"Keyboard",
	"Letter",
	"Lightbulb",
	"Locked",
	"Luggage",
	"MagnifyingGlass",
	"Medicine",
	"Microphone",
	"Monitor",
	"MouseComputer",
	"MusicNotes",
	"Necklace",
	"Option",
	"PaintBrush",
	"Pencil",
	"PetBowl",
	"PetBrush",
	"Piano",
	"Play",
	"PlayPause",
	"Plug",
	"PotionRed",
	"Power",
	"Restart",
	"Scissors",
	"ShoppingCart",
	"Skull",
	"Sleep",
	"Spatula",
	"SpeakerMute",
	"SpeakerOn",
	"Sun",
	"Team",
	"Telephone",
	"Touch",
	"Trashbin",
	"Trophy",
	"Unlocked",
	"Upload",
	"Wheat",
	"Wrench",
	"Wrench2",
	"Wrench3",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/**
 * Every icon the app renders directly rather than through a `Plate`.
 *
 * A plate's fill is one of two constant colors that do not shift with the
 * theme, so an icon on one sits on an identical ground at noon and midnight.
 * Everything here lands on `--panel` or `--ground`, both of which move, and has
 * to stay legible on all four combinations - which `assets.test.ts` asserts.
 *
 * THIS LIST IS THE ENFORCEMENT SURFACE. Nothing derives it from the app, so an
 * icon rendered unplated and not added here simply goes unchecked. The rule
 * cannot just apply to all 80: 19 of them cannot meet the floor, and
 * MusicNotes, ShoppingCart, Sleep and SpeakerOn measure 0% against the night
 * panel. Sleep is the instructive one - it really is rendered, by
 * `machineIcon`, and it is fine, because MachinesPage renders it in a `Plate`.
 */
export const UNPLATED_ICONS = [
	// AppShell's nav and wordmark. Basket rather than ChestTreasure since
	// onlooker-1kr: ChestTreasure still renders on the empty-pool state, but
	// on a teal Plate, so it is exempt by construction.
	"Basket",
	"Key",
	"Book",
	"Gear",
	"CatHead",
	"Eye",
	// Panel titles, through `Panel`'s own h2.
	"Letter",
	"Locked",
	"Pencil",
	"Trashbin",
	"Trophy",
	"MagnifyingGlass",
	// LessonDetail's status header, which renders STATUS_ICONS unplated.
	"Lightbulb",
	"Skull",
	"Restart",
] as const satisfies readonly IconName[];
