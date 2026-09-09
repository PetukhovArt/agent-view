# agent-view

The context of a tool that gives an agent DevTools-level access to a running Chromium application over the Chrome DevTools Protocol. The language here is canonical for code, plans, skills and PRs: a term in the code appears here, and a term here appears in the code.

## Targets

**Target**
A unit of CDP attachment — a page, an iframe or a worker, with its own `id`, `type`, `title` and `url`.
_Avoid_: Context, Tab, Instance

**Page Target**
A Target of type `page` or `iframe` — one with a DOM, a screenshot, input and an accessibility tree.
_Avoid_: Frame, Document

**Runtime-Only Target**
A Target of type `worker`, `shared_worker` or `service_worker`: a JS context, a console and a log, with no DOM and no image.
_Avoid_: Worker Target, Headless Target

**Unsupported Target**
A target type refused at the server boundary before any attach: `browser`, `worklet`, `auction_worklet`.

**Window**
The user-facing name of a Page Target in the CLI. Resolves to a page only, never to a worker.
_Avoid_: Screen, Viewport

## Sessions

**Runtime Session**
An attachment to a single target carrying the DOM-independent operations: evaluate an expression, subscribe to the console, close.
_Avoid_: Connection, Client

**Page Session**
A Runtime Session extended with the page operations: accessibility tree, screenshot, click, text entry. Anything that accepts a Runtime Session accepts one of these too.

**Main World**
The JS realm the page's own scripts live in. It is the scope of `eval`: a preload in an isolated world without `contextBridge` is out of sight from here.
_Avoid_: Page Context, Global Scope

**Eval Expression**
A string of JS source evaluated in the Main World of a chosen target.
_Avoid_: Script, Snippet

**Watch Expression**
An Eval Expression sampled at a fixed interval, with the differences between snapshots expressed as JSON-Patch operations (RFC 6902).
_Avoid_: Subscription, Poll, Observer

**Ref**
An opaque integer handle for a node (`[ref=N]`), issued for the life of the session and valid until the next accessibility-tree mutation. The input to click, fill, drag and screenshot cropping.
_Avoid_: Handle, NodeId, Selector

## Console and network

**Console Stream**
A server-owned subscription across several targets that reduces `Runtime.consoleAPICalled` and `Log.entryAdded` to one message shape and holds them in a per-target ring buffer.
_Avoid_: Log Stream, Logger

**Lazy Attach**
The subscription model in which the Console Stream attaches to targets on the first request: everything emitted earlier is gone. Hence the working order — clear, act, read.
_Avoid_: On-demand subscribe

**Network Stream**
A server-owned subscription to CDP network events that reduces them to one entry shape and holds them in a per-target ring buffer. Unlike the Console Stream it attaches at application launch, so page-load traffic reaches the buffer.
_Avoid_: HTTP Log, Traffic Capture, Interceptor

**Network Entry**
One request-response pair: url, method, status, mime type, resource type, timings, headers and an optional size-capped body. An unfinished request carries the status `pending` and is completed on load.
_Avoid_: Request, Record

**Request Ref**
The handle for a Network Entry for the life of the session (`[req=N]`). It hides the raw CDP `requestId`, which has no place in the CLI.
_Avoid_: RequestId, Request Handle

**WebSocket Connection**
A Network Entry of type `websocket`: the handshake plus a bounded frame log. A frame is a direction, an opcode, a size, a time and a size-capped payload. EventSource messages carry the same model.
_Avoid_: Socket, WS Session

**Sensitive Header**
A header from the authorization and cookie set whose value is emitted as `[redacted]`. The real value is available only behind an explicit flag.
_Avoid_: Secret Header, Auth Header

## Modals

**JS Dialog**
An `alert` / `confirm` / `prompt` / `beforeunload` modal. With the `Page` domain enabled Chromium does not draw it and holds the renderer until the CDP client answers, so every Page Session owns an answerer.
_Avoid_: Alert, Modal, Popup

**Dialog Policy**
The standing answer applied to a JS Dialog the moment it opens: accept or dismiss, with a text for `prompt`. It lives for the session, and every application reaches the Console Stream as a warning.
_Avoid_: Dialog Handler, Auto-accept

**File Chooser Arm**
A one-shot answer held ready for the next native file picker: a list of absolute paths, or a cancel. The first picker spends the arm, after which interception turns itself off.
_Avoid_: File Picker Mock, Prearmed Dialog

**Tauri Dialog Shim**
A page-side patch of `window.__TAURI_INTERNALS__.invoke` that answers Tauri dialog calls from the File Chooser Arm. A Tauri dialog lives in Rust past the webview, and the `invoke` call is the only seam CDP can reach. It does not survive a navigation.
_Avoid_: Tauri Patch, Dialog Stub

**Upload**
The placement of files into an `input` that already exists, over CDP. Distinct from a File Chooser Arm in that no picker takes part and the input may be hidden, and thus have no Ref.
_Avoid_: File Set, Attach

## Reachability

**Reachability Evidence**
Proof that a user action executes a given piece of code, obtained by running the application rather than by reading the diff. The asymmetry sets the whole model: showing that a path exists costs one pass, showing that none does costs every path — so unreachability is never asserted here, and "found nothing" is a valid answer.
_Avoid_: Dead Code Check, Reachability Proof, Coverage

**Coverage Window**
The interval between two precise-coverage takes on one target. The granularity is the function, not the line, so no source map takes part. The window lives in the V8 isolate: a reload wipes it.
_Avoid_: Coverage Session, Profile Range

**Hidden Script**
A script dropped from the coverage output by default: dependencies, runtime bundles, and scripts with no URL at all (`eval`, `new Function`). A url-less script cannot be pointed at in a review, which is the only thing the output is for.
_Avoid_: Filtered Script, Noise

**Event Listener**
A handler declared on one node: the event type, the capture / passive / once flags and the declaration site. Delegation from an ancestor is out of sight on that node.
_Avoid_: Handler, Callback, Subscriber

**Script-URL Scan**
A momentary enable of the `Debugger` domain for the sake of the one CDP source of the `scriptId` → URL correspondence. The domain does not stay on: with it, V8 holds the code deoptimized for every other command on the session.
_Avoid_: Script Map, Debugger Scan

## Memory

**Heap Snapshot**
A named, GC-first capture of one target's V8 heap, kept in the server as a class table and a typed-array graph. Compared to another by class; never shown raw.
_Avoid_: Memory Dump, Profile

**Detached DOM Node**
A DOM node out of the document but still referenced from JS, so it cannot be collected. V8 marks it in the snapshot; here it prints as its own class, `Detached <tag …>`.
_Avoid_: Orphan Node, Zombie Element, Leaked Element

**Heap Class**
The grouping unit of every `heap` view, as V8 names it: JS objects by constructor, DOM nodes by tag and attributes, everything else by kind in parentheses. A Detached DOM Node is its own Heap Class.
_Avoid_: Type, Constructor, Bucket

**Retainer**
The object and the edge (property or index) through which an instance is kept alive, one hop up the graph, strong edges only. Not a retaining path: the hop after it is not computed.
_Avoid_: Owner, Parent, Reference Holder

**Backing Store**
A V8-internal node (`(object elements)`, `system / OrderedHashMap`) that holds a collection's items on behalf of the `Array` or `Map` a developer wrote. Never shown as a Retainer: edges out of it are attributed to its owner.
_Avoid_: Internal Node, Hidden Node

## Server

**Lazy Server**
A local TCP server with token authentication that spawns itself on the first CLI call and exits after an idle period. It owns the CDP sockets and the caches, so every command goes through it rather than into CDP directly.
_Avoid_: Daemon, Background Service

**allowEval**
A config flag — the project owner's consent to arbitrary JS execution. The token authenticates the socket but not the execution: that is a separate decision, and without the flag `eval` and `watch` are refused.
_Avoid_: Unsafe Mode, Eval Flag

**captureBody**
A config flag that opens response bodies and request payloads in a Network Entry. One flag for both directions: each of them carries tokens and personal data.
_Avoid_: Body Capture Mode, Include Bodies

## Verification

**Verification Run**
One pass of the `verify` skill against a live application: bring it up, work the steps with agent-view commands, match each observation against the expectation, and give a verdict per step.
_Avoid_: Test Run, QA Pass

**Invariant**
A property that holds regardless of the path by which the state was reached, expressed as an Eval Expression whose result has the shape `{model, dom, match}`.
_Avoid_: Assertion, Check

**Design Conformance**
The comparison of a captured screenshot against a reference image, given as the triple of a label, a capture command and a reference path.
_Avoid_: Visual Regression, Pixel Diff

**requires_visual_review**
A Verification Run step verdict: an executable check was made and gave no answer, and no one has looked at the step yet. Not a way to describe a step that has no executable check.
_Avoid_: Manual Check, TODO
