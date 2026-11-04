# Spaces

Space membership routes, item availability, and space deletion live here, with availability helpers choosing visible items and rehoming assignments when availability changes. Organization ownership and account deletion remain in `accounts`, which calls this module for space cleanup.

`spacesRoutes` and `availabilityRoutes` build RPC handlers, while other modules use `setAvailability`, `chooseForSpace`, and the related locking helpers. `deleteSpaceWithContent` coordinates content removal through injected storage and provider dependencies.
