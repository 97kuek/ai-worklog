# Taskfolio interface design

English · [日本語](DESIGN.ja.md) · [README](README.md)

Taskfolio puts the work record first. The same header links the weekly log, calendar, board, activity reports, skills and office. The gear opens Settings, and the refresh button updates the current view. [Page structure](worker/public/index.html)

## Color and type

| Element | Treatment |
| --- | --- |
| Surfaces | White pages and panels. Subtle borders divide controls, rows and groups. |
| Text | Dark ink (`#20232d`) for task names and primary content. Metadata uses a muted mix of ink and white. |
| Selection | Indigo (`#4531b5`) for the active navigation item, table headers and keyboard focus. A lighter lavender marks selected days and waiting work. |
| Type | System sans-serif. Body text follows the browser's base size, section headings use 1.25rem and page titles use 2rem. |

The shared stylesheet defines these tokens and the maximum content width of 1280px. Reuse them when adding a view. The 3D office has its own materials and lighting. [Shared CSS](worker/public/worklog.css) · [Office scene source](design/office/Taskfolio.blend)

## Interaction

- **Log and calendar.** Tasks retain readable names and open a shared detail dialog. Calendar blocks split at local midnight, and overlapping work sits side by side. Text identifies the status as well as color. [Calendar](worker/ui/calendar.ts) · [Task details](worker/ui/detail.ts)
- **Board.** Group cards by their stage. Provide a move button alongside drag-and-drop so keyboard and touch users can queue a request. Completed sessions remain in the underlying history when they age out of the board. [Planning lanes](worker/ui/planning.ts) · [Session lanes](worker/ui/board.ts)
- **Activity and Office.** Activity supports moving from a week to a day and then to an hour. Office pairs the 3D scene with a selectable task list. [Activity](worker/ui/stats.ts) · [Office](worker/ui/office.ts)
- **Settings.** Group folders, engines, last check-in and connection testing by Mac. A folder switch controls permission for future launches. Distinguish the Mac's check-in from successful execution of a request. [Settings](worker/ui/settings.ts)

## Small screens and keyboard use

Navigation collapses into a menu at 1023px and below. On small screens the calendar offers a day selector and common controls have 44px touch targets. Keep a visible keyboard focus ring, the skip link, accessible names on icon buttons and text feedback for actions. Verify both touch and keyboard operation when changing a control. [Shared controls](worker/public/worklog.css) · [Calendar layout](worker/public/calendar.css)
