# Scenario: search → navigate → fill form → submit → verify

Stable E2E scenario for the bench app. Used as baseline for token/timing optimization comparisons.

## Preconditions

```bash
cd bench/app && npm start   # Electron on port 19222, CDP enabled
```

Verify app is reachable:
```bash
agent-view discover
```
Expected: JSON array with at least one window entry.

---

## Steps

### 1. Fill search input with "form"

```bash
rtk agent-view fill --filter "Search" "form"
```

**PASS**: no error output  
**FAIL**: command returns error → check that bench app is running and search input has `aria-label="Search"`

---

### 2. Verify search found the Form section

```bash
rtk agent-view dom --filter "1 section found" --depth 2
```

`p#search-hint` has `role="status"` so it is exposed in the AX tree.

**PASS**: output contains `1 section found`  
**FAIL**: text not in DOM → search JS filter not firing; check `index.html` `input` event listener

---

### 3. Navigate to Form section via nav link

```bash
agent-view click --filter "Form"
```

Clicks the `<a href="#form">Form</a>` nav link — scrolls to the Form section.

**PASS**: no error output  
**FAIL**: element not found → re-run `rtk agent-view dom --filter "Form" --depth 1` to inspect

---

### 4. Verify form fields are accessible

```bash
rtk agent-view dom --filter "Name" --depth 8
```

Form fields sit 7 levels deep in the AX tree (root → none → none → main → region → generic → label → textbox). Needs `--depth 8`.

**PASS**: output contains `textbox "Name"`  
**FAIL**: form section not in AX tree → check section is not `display:none`

---

### 5. Fill Name field

```bash
agent-view fill --filter "Name" "Test User"
```

**PASS**: no error output  
**FAIL**: element not found → use `dom --filter "Name" --depth 2` to get ref, then `fill <ref> "Test User"`

---

### 6. Fill Email field

```bash
agent-view fill --filter "Email" "test@example.com"
```

**PASS**: no error output  
**FAIL**: element not found → use `dom --filter "Email" --depth 2` to get ref

---

### 7. Select Option A

```bash
agent-view click --filter "Option A"
```

**PASS**: no error output  
**FAIL**: radio not found → check `aria-label="Option A"` on the radio input in `index.html`

---

### 8. Submit the form

```bash
agent-view click --filter "Submit"
```

**PASS**: no error output  
**FAIL**: element not found → verify Submit button exists via `dom --filter "Submit" --depth 1`

---

### 9. Verify success message

```bash
rtk agent-view dom --filter "Form submitted successfully" --depth 8
```

**PASS**: output contains `Form submitted successfully`  
**FAIL**: text not found → form validation rejected the input; run step 10 first to see errors

---

### 10. Verify no error summary visible

```bash
rtk agent-view dom --filter "Please fix" --depth 8
```

**PASS**: output contains `(no matching` — error summary is `display:none`, not in AX tree  
**FAIL**: error summary is visible → one or more fields failed validation; check steps 5–7

---

### 11. Verify no field-level errors

```bash
rtk agent-view dom --filter "is required" --depth 8
```

**PASS**: output contains `(no matching` — all error spans are hidden  
**FAIL**: one or more field errors are visible in AX tree

---

### 12. Screenshot (final visual confirm)

```bash
agent-view screenshot --scale 0.5
```

Attach path to scenario report as visual evidence of success state.

---

## Expected final state

- `Form submitted successfully` visible in DOM (role=status)
- Error summary (`Please fix the errors above`) — **not** in AX tree
- Field errors for Name, Email, Option — **not** in AX tree
- Form fields retain their filled values

## Ref resolution (if needed)

If `--filter` matches multiple elements or the wrong one, resolve to a specific ref first:

```bash
rtk agent-view dom --filter "Name" --depth 2
# → [12] textbox "Name"
agent-view fill 12 "Test User"
```

## Reset between runs

```bash
agent-view click --filter "Reset"
```

Clears all form fields and hides success/error messages.
