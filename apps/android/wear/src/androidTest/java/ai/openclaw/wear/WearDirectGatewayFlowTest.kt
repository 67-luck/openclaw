package ai.openclaw.wear

import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentity
import ai.openclaw.app.gateway.normalizeGatewayTlsFingerprintInput
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Point
import android.graphics.Rect
import android.os.Bundle
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import androidx.test.uiautomator.waitForStable
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AccessDeniedException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest

/** Explicit live proof; the private input and isolated Gateway are provisioned outside the test. */
@RunWith(AndroidJUnit4::class)
class WearDirectGatewayFlowTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private lateinit var device: UiDevice
  private val app by lazy { instrumentation.targetContext.applicationContext as WearApplication }

  @Test
  fun limitedSetupAndDurableGatewayFlow() {
    device = UiDevice.getInstance(instrumentation)
    assumeTrue(InstrumentationRegistry.getArguments().getString("wearDirectGatewayProof") == "true")
    val input = consumeInput()
    val checkpointFile = File(app.filesDir, "wear-direct-gateway-checkpoint.json")
    val previous = readPreviousCheckpoint(input, checkpointFile)
    val fingerprint = normalizeGatewayTlsFingerprintInput(input.certificateSha256)
    assertTrue("private fixture names an exact certificate", fingerprint != null)
    assertTrue("installed application matches the qualified APK", fileSha256(File(app.applicationInfo.sourceDir)) == input.apkSha256)
    assertTrue("installed test matches the qualified test APK", fileSha256(File(instrumentation.context.applicationInfo.sourceDir)) == input.testApkSha256)
    val runtime = app.directRuntime
    val processJob = requireNotNull(app.processScope.coroutineContext[Job])
    assertTrue("application coroutine owner is active", processJob.isActive)
    val store = WearGatewayStore.create(app)
    val gatewayId =
      if (previous == null) {
        assertTrue(
          "native proof requires an empty isolated watch registry",
          store.registry.entries.value
            .isEmpty(),
        )
        assertTrue("native proof starts in Phone Proxy", runtime.isPhoneProxySelected())
        val setup = runCatching { parseWearGatewaySetup(input.setupCode.orEmpty()) }.getOrNull()
        assertTrue("private fixture uses a limited TLS setup code", setup != null && setup.endpoint.tlsEnabled)
        requireNotNull(setup).endpoint.stableId
      } else {
        assertTrue("reopen cannot supply bootstrap credentials", input.setupCode == null)
        assertTrue("reopen preserves the selected Gateway", store.registry.activeEntry()?.stableId == previous.gatewayId)
        assertTrue("reopen has no retained bootstrap credential", store.bootstrap(previous.gatewayId) == null)
        assertTrue("reopen loads the persisted certificate before connecting", normalizeGatewayTlsFingerprintInput(store.getString("gateway.tls.${previous.gatewayId}").orEmpty()) == fingerprint)
        assertTrue("new process reloads the saved grant before connecting", readSavedGrant(store, previous.gatewayId) == previous.grant)
        previous.gatewayId
      }
    var activity: MainActivity? = null
    var failure: Throwable? = null
    var transport: ResumeInput? = null
    var foregroundRetired = false
    var backgroundRetired = false
    try {
      activity =
        instrumentation.startActivitySync(
          Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        ) as MainActivity
      if (previous == null) {
        // Connection is an ordinary Phone Proxy control, not a test-only launch route.
        var preTap: JsonObject? = null
        var navigationStage = "connection-lookup"
        try {
          clickAction(activity, app.getString(R.string.watch_connection)) {
            preTap = runCatching { navigationSnapshot(activity, runtime) }.getOrNull()
            navigationStage = "connection-click"
          }
          navigationStage = "setup-lookup"
          val setupSelector = By.pkg(app.packageName).text(app.getString(R.string.watch_setup_code)).enabled(true)
          val deadline = SystemClock.elapsedRealtime() + 3_000
          var setupPresent = device.hasObject(setupSelector)
          if (!setupPresent) {
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining > 0) setupPresent = device.wait(Until.hasObject(setupSelector), remaining)
          }
          // Until may return after its budget; late presence is not a successful transition.
          assertTrue(
            "enabled Setup appears without post-click scrolling within 3000ms",
            setupPresent && SystemClock.elapsedRealtime() <= deadline,
          )
          navigationStage = "setup-click"
          clickAction(activity, app.getString(R.string.watch_setup_code), allowScroll = false)
        } catch (error: Throwable) {
          // This bracket ends before credential entry. Diagnostics must neither expose
          // later screens nor replace the original failure or the outer cleanup.
          runCatching {
            val failed = runCatching { navigationSnapshot(activity, runtime) }.getOrNull()
            val diagnostic =
              buildJsonObject {
                put("schema", "wear-bootstrap-navigation-v1")
                put("runId", input.runId)
                put("phase", input.phase)
                put("sourceCommit", input.sourceCommit)
                put("sourceTree", input.sourceTree)
                put("apkSha256", input.apkSha256)
                put("testApkSha256", input.testApkSha256)
                put("nonceSha256", sha256(input.nonce.toByteArray()))
                put("stage", navigationStage)
                put("preTap", preTap ?: JsonNull)
                put("failure", failed ?: JsonNull)
              }
            check(Json.encodeToString(diagnostic).toByteArray().size <= 32_768)
            writeProof(File(app.filesDir, "wear-direct-bootstrap-navigation.json"), diagnostic)
          }.onFailure { diagnosticFailure ->
            error.addSuppressed(
              diagnosticFailure as? ProofWriteFailure ?: ProofWriteFailure("prepare-diagnostic", diagnosticFailure),
            )
          }
          throw error
        }
        val baselineOwner = runCatching { runtime.inputOwner() }.getOrNull()
        val baseline = runCatching { certificateSnapshot(activity, runtime.state.value, gatewayId) }.getOrNull()
        try {
          setAccessibleText(uniqueEditor(password = true), requireNotNull(input.setupCode))
          clickAction(activity, app.getString(R.string.watch_connect))
          awaitState("current certificate prompt") { runtime.state.value.trust != null }
        } catch (error: Throwable) {
          runCatching {
            val failedOwner = runtime.inputOwner()
            val failed = certificateSnapshot(activity, runtime.state.value, gatewayId)
            val diagnostic =
              buildJsonObject {
                put("schema", "wear-certificate-boundary-v1")
                put("inputOwnerChanged", baselineOwner?.let { failedOwner != it })
                put("baseline", baseline ?: JsonNull)
                put("failure", failed)
              }
            val encoded = Json.encodeToString(diagnostic)
            check(encoded.toByteArray().size <= 4096)
            // The runner retains suppressed messages in its existing failure stream.
            error.addSuppressed(AssertionError("wear-certificate-boundary:$encoded").apply { stackTrace = emptyArray() })
          }.onFailure {
            error.addSuppressed(
              AssertionError("wear-certificate-diagnostic-unavailable").apply { stackTrace = emptyArray() },
            )
          }
          throw error
        }
        val prompt = requireNotNull(runtime.state.value.trust)
        assertTrue("certificate belongs to the provisioned Gateway", normalizeGatewayTlsFingerprintInput(prompt.fingerprint) == fingerprint)
        assertTrue(
          "setup selects the provisioned endpoint",
          runtime.state.value.selected
            ?.stableId == gatewayId,
        )
        findText(app.getString(R.string.watch_certificate))
        clickAction(activity, app.getString(R.string.watch_trust_certificate))
      }
      awaitState("saved limited credentials establish a direct operator connection") {
        val state = runtime.state.value
        state.connected && state.trust == null && state.error == null && store.bootstrap(gatewayId) == null
      }
      assertTrue("certificate approval is persisted", normalizeGatewayTlsFingerprintInput(store.getString("gateway.tls.$gatewayId").orEmpty()) == fingerprint)
      val savedGrant = readSavedGrant(store, gatewayId)
      if (previous != null) assertTrue("new connection retains device identity", savedGrant.deviceIdSha256 == previous.grant.deviceIdSha256)
      findText("Connected directly")
      capture(input.phase, "01-connected")

      clickAction(activity, app.getString(R.string.watch_sessions))
      awaitState("seeded session is listed") {
        runtime.state.value.sessions
          .any { it.key == input.sessionKey && it.title == input.sessionTitle }
      }
      clickAction(activity, input.sessionTitle)
      awaitState("selected session owns canonical history") {
        val state = runtime.state.value
        state.connected && state.sessionKey == input.sessionKey && state.messages.any { it.text.contains(input.historyMarker) }
      }
      findText(input.historyMarker, contains = true)
      capture(input.phase, "02-history")
      if (previous == null) exerciseHelpAndDeny(activity, runtime, input)
      assertTrue("native Home action succeeded", device.pressHome())
      awaitPaused(runtime, activity, finishing = false)
      assertTrue("Home preserves the application coroutine owner", processJob.isActive)
      writeProof(
        File(app.filesDir, "wear-direct-${input.phase}-background-ready.json"),
        BackgroundReady(input.runId, input.nonce, input.phase, savedGrant.deviceIdSha256),
      )
      val closureFile = File(app.filesDir, "wear-direct-${input.phase}-background-input.json")
      awaitState("Gateway observer confirms old client closure before resume") { closureFile.exists() }
      val closure = consumePrivate<ClosureInput>(closureFile, 8192)
      assertTrue(
        "server closure belongs to this phase",
        closure.runId == input.runId && closure.nonce == input.nonce && closure.phase == input.phase &&
          closure.expiresAtMs - System.currentTimeMillis() in 1..900_000 && closure.closedConnectionLogKey.isNotBlank() &&
          closure.expectedSessionKey == input.sessionKey && closure.injectionMessageId.isNotBlank() &&
          closure.freshHistoryMarker.length in 1..1024,
      )
      assertTrue(
        "resume evidence is not retained history",
        runtime.state.value.messages
          .none { it.text.contains(closure.freshHistoryMarker) },
      )
      instrumentation.context.startActivity(
        Intent(app, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
      )
      awaitState("foreground resume reconnects the same conversation") {
        val state = runtime.state.value
        state.connected && state.trust == null && state.sessionKey == input.sessionKey &&
          state.messages.any { it.text.contains(closure.freshHistoryMarker) }
      }
      val resumeFile = File(app.filesDir, "wear-direct-${input.phase}-resume-input.json")
      awaitState("Gateway logs confirm a new connection and successful history after automatic resume") { resumeFile.exists() }
      val resumed = consumePrivate<ResumeInput>(resumeFile, 8192)
      assertTrue(
        "shortened log keys and fresh content bind history to the retired connection",
        resumed.runId == input.runId && resumed.nonce == input.nonce && resumed.phase == input.phase &&
          resumed.expiresAtMs - System.currentTimeMillis() in 1..900_000 && resumed.previousConnectionLogKey == closure.closedConnectionLogKey &&
          resumed.connectionLogKey.isNotBlank() && resumed.connectionLogKey != closure.closedConnectionLogKey &&
          resumed.requestLogKey.isNotBlank() && resumed.method == "chat.history" && resumed.methodSucceeded &&
          resumed.expectedSessionKey == input.sessionKey && resumed.freshHistoryMarker == closure.freshHistoryMarker,
      )
      transport = resumed
      assertTrue("automatic resume preserves the application coroutine owner", processJob.isActive)
      assertTrue("resume retains device identity and limited scopes", savedGrant.deviceIdSha256 == readSavedGrant(store, gatewayId).deviceIdSha256)
      findText("Connected directly")
      findText(closure.freshHistoryMarker, contains = true)
      capture(input.phase, "05-resumed")
      clickAction(activity, app.getString(R.string.watch_disconnect))
      awaitState("foreground Disconnect retires its connection before Activity finish") {
        val state = runtime.state.value
        !state.connected && !state.busy && state.status == "Disconnected" && state.error == null
      }
      foregroundRetired = true
    } catch (error: Throwable) {
      failure = error
      throw error
    } finally {
      var cleanupFailure: Throwable? = null
      try {
        activity?.let { current ->
          instrumentation.runOnMainSync { current.finish() }
          instrumentation.waitForIdleSync()
          awaitPaused(runtime, current, finishing = true)
          backgroundRetired = true
        }
      } catch (cleanup: Throwable) {
        cleanupFailure = cleanup
      }
      try {
        // Explicit TEST teardown, not automatic Activity cleanup. This independent coroutine
        // joins the application owner only after the live Home/resume and final stop observations.
        runBlocking { withTimeout(15_000) { processJob.cancelAndJoin() } }
      } catch (cleanup: Throwable) {
        if (cleanupFailure == null) cleanupFailure = cleanup else cleanupFailure.addSuppressed(cleanup)
      }
      cleanupFailure?.let { cleanup ->
        if (failure == null) throw cleanup else failure.addSuppressed(cleanup)
      }
    }
    val checkpoint =
      Checkpoint(
        input.runId,
        input.nonce,
        Process.myPid(),
        Process.getStartElapsedRealtime(),
        input.sourceCommit,
        input.sourceTree,
        input.apkSha256,
        input.testApkSha256,
        gatewayId,
        requireNotNull(fingerprint),
        readSavedGrant(store, gatewayId),
        requireNotNull(transport),
        Teardown(foregroundRetired, backgroundRetired, processJob.isCancelled, processJob.isCompleted),
      )
    // The external harness must join instrumentation, observe socket closure, then restart only
    // its owned app process. A fresh nonce and process start distinguish reopen from Activity resume.
    writeProof(if (previous == null) checkpointFile else File(app.filesDir, "wear-direct-gateway-reopen.json"), checkpoint)
  }

  @Test
  fun privateProofWriterPublishesWithoutOverwrite() {
    assumeTrue(InstrumentationRegistry.getArguments().getString("wearProofWriterProbe") == "true")
    val directory =
      try {
        Files.createTempDirectory(instrumentation.targetContext.filesDir.toPath(), "wear-proof-writer-")
      } catch (error: Throwable) {
        throw ProofWriteFailure("fixture-create", error)
      }
    val file = directory.resolve("proof.json").toFile()
    val value = buildJsonObject { put("synthetic", true) }
    var failure: Throwable? = null
    try {
      writeProof(file, value)
      val original = file.readBytes()
      assertTrue("published proof has exact content", original.contentEquals(Json.encodeToString(value).toByteArray()))
      assertTrue(
        "published proof is private",
        Files.getPosixFilePermissions(file.toPath(), LinkOption.NOFOLLOW_LINKS) == PosixFilePermissions.fromString("rw-------"),
      )
      assertTrue("successful publication removes its temporary file", directory.toFile().list()?.toList() == listOf("proof.json"))
      val refused = runCatching { writeProof(file, buildJsonObject { put("synthetic", false) }) }.exceptionOrNull()
      assertTrue(
        "existing proof is refused before another temporary file",
        refused is ProofWriteFailure && refused.operation == "no-overwrite" && refused.category == "ASSERTION",
      )
      assertTrue("overwrite refusal preserves original bytes", file.readBytes().contentEquals(original))
      assertTrue("overwrite refusal leaves no temporary file", directory.toFile().list()?.toList() == listOf("proof.json"))
    } catch (error: Throwable) {
      val reported = if (error is AssertionError) error else ProofWriteFailure("fixture-verify", error)
      failure = reported
      throw reported
    } finally {
      try {
        assertTrue("owned producer fixture is removed", directory.toFile().deleteRecursively())
      } catch (cleanup: Throwable) {
        val marker = ProofWriteFailure("fixture-cleanup", cleanup)
        if (failure == null) throw marker else failure.addSuppressed(marker)
      }
    }
  }

  private fun exerciseHelpAndDeny(
    activity: MainActivity,
    runtime: WearDirectRuntime,
    input: ProofInput,
  ) {
    assertTrue(
      "help evidence is not preseeded",
      runtime.state.value.messages
        .none { it.text.contains(input.helpMarker) },
    )
    clickAction(activity, app.getString(R.string.message))
    val message = uniqueEditor(password = false)
    setAccessibleText(message, "/help")
    assertTrue("real input submits help", message.accessibilityNodeInfo.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id))
    awaitState("help input reaches its captured conversation") {
      val state = runtime.state.value
      state.connected && (state.pendingSend?.message == "/help" || state.messages.any { it.text.contains(input.helpMarker) })
    }
    // Returning from the platform editor may precede reconnect; the UI owns explicit retry.
    if (runtime.state.value.pendingSend != null && !runtime.state.value.sending) {
      assertTrue(
        "only this help message is pending",
        runtime.state.value.pendingSend
          ?.message == "/help",
      )
      clickAction(activity, app.getString(R.string.retry))
    }
    awaitState("Gateway help response settles the real send") {
      val state = runtime.state.value
      state.sessionKey == input.sessionKey && state.pendingSend == null && !state.sending && !state.sendUnknown &&
        state.messages.any { it.role == "assistant" && it.text.contains(input.helpMarker) }
    }
    findText(input.helpMarker, contains = true)
    capture(input.phase, "03-help")
    awaitState("session subscription is eligible before canonical approval creation") {
      val state = runtime.state.value
      state.connected && state.sessionKey == input.sessionKey && state.approvalsReady
    }
    // The external owner calls plugin.approval.request(twoPhase=true) only after this signal,
    // verifies accepted/pending, and returns the server-generated ID. No event is fabricated here.
    writeProof(
      File(app.filesDir, "wear-direct-approval-ready.json"),
      ApprovalReady(input.runId, input.nonce, input.sessionKey),
    )
    val approvalFile = File(app.filesDir, "wear-direct-approval-input.json")
    awaitState("canonical request owner supplies its accepted server ID") { approvalFile.exists() }
    val request = consumePrivate<ApprovalInput>(approvalFile, 8192)
    assertTrue(
      "canonical request input belongs to this phase and has not expired",
      request.runId == input.runId && request.nonce == input.nonce && request.sessionKey == input.sessionKey &&
        request.expiresAtMs - System.currentTimeMillis() in 1..900_000 && request.id.isNotBlank() && request.id.length <= 1024,
    )
    awaitState("server-generated approval reaches the actual watch subscription") {
      runtime.state.value.approvals
        .any { it.id == request.id }
    }
    val approval =
      runtime.state.value.approvals
        .single { it.id == request.id }
    assertTrue(
      "only the provisioned session-bound deny-only approval is exercised",
      approval.sourceSessionKey == input.sessionKey && approval.status == "pending" && approval.title == input.approvalTitle &&
        approval.decisions == listOf("deny") && approval.reviewIssue == null && approval.canResolve("deny", System.currentTimeMillis()),
    )
    clickAction(activity, app.getString(R.string.watch_approvals))
    clickAction(activity, "${input.approvalTitle}: pending")
    findText(input.sessionKey)
    clickAction(activity, app.getString(R.string.watch_deny))
    findText(app.getString(R.string.watch_confirm_decision, app.getString(R.string.watch_deny))).recycle()
    capture(input.phase, "04-pending")
    clickAction(activity, app.getString(R.string.watch_confirm_decision, app.getString(R.string.watch_deny)))
    awaitState("canonical deny acknowledgement is settled") {
      val state = runtime.state.value
      state.sessionKey == input.sessionKey && request.id !in state.resolving &&
        state.approvals.any { it.id == request.id && it.status == "denied" && it.decision == "deny" }
    }
    findText("denied")
    capture(input.phase, "04-denied")
    // The external request owner must match this with waitDecision=deny and terminal approval.get.
    writeProof(
      File(app.filesDir, "wear-direct-approval-confirmed.json"),
      ApprovalConfirmed(input.runId, input.nonce, request.id, "deny"),
    )
    device.pressBack()
    device.pressBack()
  }

  private fun awaitPaused(
    runtime: WearDirectRuntime,
    activity: MainActivity,
    finishing: Boolean,
  ) {
    // changeIntent publishes Paused/busy=false after its retired session and TLS probe join.
    // The external Gateway observation remains separate evidence of physical socket closure.
    awaitState("runtime foreground owner settles after stop") {
      var stopped = false
      instrumentation.runOnMainSync {
        stopped =
          if (finishing) {
            !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) && activity.isFinishing
          } else {
            activity.lifecycle.currentState == Lifecycle.State.CREATED && !activity.isFinishing
          }
      }
      val state = runtime.state.value
      stopped && !state.connected && !state.busy && state.status == "Paused"
    }
  }

  private fun readSavedGrant(
    store: WearGatewayStore,
    gatewayId: String,
  ): SavedGrant {
    val identity =
      store.getString("device.identity")?.let { raw ->
        runCatching { Json.decodeFromString<DeviceIdentity>(raw) }.getOrNull()
      }
    assertTrue("production connection saved its identity", identity != null)
    val grant = DeviceAuthStore(store).loadEntry(gatewayId, requireNotNull(identity).deviceId, "operator")
    assertTrue(
      "handoff saves only the required limited operator grant",
      grant != null && grant.token.isNotBlank() && grant.scopes.toSet() == setOf("operator.read", "operator.write", "operator.approvals"),
    )
    return SavedGrant(sha256(identity.deviceId.toByteArray()), sha256(requireNotNull(grant).token.toByteArray()))
  }

  private fun consumeInput(): ProofInput {
    // No credential command-line argument, repository fixture, log, or hierarchy dump.
    return consumePrivate<ProofInput>(File(app.filesDir, "wear-direct-gateway-proof.json"), 32_768).also {
      assertTrue(
        "private native input has bounded nonempty expectations",
        (it.setupCode == null || it.setupCode.length in 1..16_384) &&
          listOf(it.sessionKey, it.sessionTitle, it.historyMarker, it.helpMarker, it.approvalTitle).all { value -> value.isNotBlank() && value.length <= 1024 },
      )
      assertTrue("private native input names one bounded run", it.runId.matches(Regex("[a-zA-Z0-9_-]{1,80}")) && it.nonce.matches(Regex("[a-f0-9]{64}")))
      assertTrue("private native input has not expired", it.expiresAtMs - System.currentTimeMillis() in 1..900_000)
      assertTrue("private native input names an explicit phase", it.phase in setOf("bootstrap", "reopen"))
      assertTrue("private native input binds build digests", listOf(it.apkSha256, it.testApkSha256).all { value -> value.matches(Regex("[a-f0-9]{64}")) })
      assertTrue("private native input declares exact source", listOf(it.sourceCommit, it.sourceTree).all { value -> value.matches(Regex("[a-f0-9]{40}")) })
    }
  }

  private inline fun <reified T> consumePrivate(
    file: File,
    limit: Long,
  ): T {
    assertTrue("private native input is present and bounded", Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) && file.length() in 1..limit)
    val input =
      try {
        runCatching { Json.decodeFromString<T>(file.readText()) }.getOrNull()
      } finally {
        assertTrue("private native input was consumed before effects", file.delete())
      }
    assertTrue("private native input has the expected shape", input != null)
    return requireNotNull(input)
  }

  private inline fun <reified T> writeProof(
    file: File,
    value: T,
  ) {
    var operation = "no-overwrite"
    var pending: Path? = null
    var failure: ProofWriteFailure? = null
    try {
      assertTrue("private proof is not overwritten", !Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS))
      operation = "create-temp"
      pending =
        Files.createTempFile(
          file.toPath().parent,
          ".wear-proof-",
          ".tmp",
          PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")),
        )
      operation = "open"
      FileOutputStream(pending.toFile()).use {
        operation = "encode"
        val bytes = Json.encodeToString(value).toByteArray()
        operation = "write"
        it.write(bytes)
        operation = "sync"
        it.fd.sync()
        operation = "close"
      }
      // This instrumentation is the exclusive publisher; the entry check refuses existing receipts.
      // Publish only completed, synced bytes. Concurrent publishers are not supported.
      operation = "move"
      Files.move(pending, file.toPath(), StandardCopyOption.ATOMIC_MOVE)
      pending = null
    } catch (error: Throwable) {
      // Capture the first operation before cleanup can fail; never retain raw paths or causes.
      failure = ProofWriteFailure(operation, error)
      throw failure
    } finally {
      if (pending != null) {
        try {
          Files.delete(pending)
        } catch (cleanup: Throwable) {
          val marker = ProofWriteFailure("delete-temp", cleanup)
          if (failure == null) throw marker else failure.addSuppressed(marker)
        }
      }
    }
  }

  private class ProofWriteFailure(
    val operation: String,
    error: Throwable,
  ) : AssertionError() {
    val category =
      when (error) {
        is AccessDeniedException -> "ACCESS_DENIED"
        is FileAlreadyExistsException -> "ALREADY_EXISTS"
        is NoSuchFileException -> "NOT_FOUND"
        is UnsupportedOperationException -> "UNSUPPORTED"
        is SecurityException -> "SECURITY"
        is IOException -> "IO"
        is IllegalArgumentException -> "ARGUMENT"
        is AssertionError -> "ASSERTION"
        else -> "OTHER"
      }

    override val message: String get() = "private-proof-write:$operation:$category"

    init {
      stackTrace = emptyArray()
    }
  }

  private fun readPreviousCheckpoint(
    input: ProofInput,
    file: File,
  ): Checkpoint? {
    if (input.phase == "bootstrap") {
      assertTrue("bootstrap has no stale phase checkpoint", !file.exists() && input.previousNonce == null)
      return null
    }
    assertTrue("reopen has a bounded phase checkpoint", Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) && file.length() in 1..8192)
    val previous = runCatching { Json.decodeFromString<Checkpoint>(file.readText()) }.getOrNull()
    assertTrue("reopen checkpoint has the expected shape", previous != null)
    return requireNotNull(previous).also {
      assertTrue("reopen belongs to the completed bootstrap phase", it.runId == input.runId && it.nonce == input.previousNonce && it.nonce != input.nonce)
      assertTrue(
        "reopen accepts only a completed prior teardown",
        it.teardown.foregroundDisconnectSettled && it.teardown.activityBackgroundSettled &&
          it.teardown.explicitTestCoroutineOwnerCancelled && it.teardown.explicitTestCoroutineOwnerJoined,
      )
      assertTrue("reopen is a different later app process", it.pid != Process.myPid() && it.processStartElapsedMs < Process.getStartElapsedRealtime())
      assertTrue("reopen retains the same build inputs", it.sourceCommit == input.sourceCommit && it.sourceTree == input.sourceTree && it.apkSha256 == input.apkSha256 && it.testApkSha256 == input.testApkSha256)
      assertTrue("reopen retains the expected certificate", it.certificateSha256 == normalizeGatewayTlsFingerprintInput(input.certificateSha256))
    }
  }

  private fun uniqueEditor(password: Boolean): UiObject2 {
    var matches = emptyList<UiObject2>()
    awaitState("one visible native editor") {
      matches =
        device.findObjects(By.clazz("android.widget.EditText")).filter {
          val node = it.accessibilityNodeInfo
          node.isEditable && node.isEnabled && node.isVisibleToUser && node.isPassword == password
        }
      matches.size == 1
    }
    return matches.single()
  }

  private fun setAccessibleText(
    editor: UiObject2,
    value: String,
  ) {
    // UiAutomator 2.4.0 setText logs its argument; invoke the public node action directly.
    val arguments = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value) }
    assertTrue("native editor accepted input", editor.accessibilityNodeInfo.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments))
  }

  private fun certificateSnapshot(
    activity: MainActivity,
    state: WearDirectState,
    gatewayId: String,
  ): JsonObject =
    buildJsonObject {
      // Owner, state, and Activity observations are non-atomic; busy=false is not completion.
      put("selectedPresent", state.selected != null)
      put("expectedEndpointMatch", state.selected?.stableId == gatewayId)
      put("selectedTls", state.selected?.tls == true)
      put("busy", state.busy)
      put("trustPresent", state.trust != null)
      put("connected", state.connected)
      put("managementRequired", state.connectionManagementRequired)
      put("activityLifecycle", activity.lifecycle.currentState.name)
      put("activityFocused", activity.hasWindowFocus())
      put(
        "status",
        when (state.status) {
          "Disconnected" -> "DISCONNECTED"
          "Paused" -> "PAUSED"
          "Connecting" -> "CONNECTING"
          "Verify Gateway certificate" -> "VERIFY_CERTIFICATE"
          "Connected directly" -> "CONNECTED_DIRECTLY"
          else -> "UNKNOWN"
        },
      )
      put(
        "error",
        when (state.error) {
          null -> "NONE"
          "Setup code is too large." -> "SETUP_TOO_LARGE"
          "Enter a limited Gateway setup code." -> "LIMITED_SETUP_REQUIRED"
          "Use a limited setup code, not a phone token or password." -> "PHONE_CREDENTIALS_REJECTED"
          "The setup code has an invalid or insecure Gateway URL." -> "SETUP_URL_INVALID_OR_INSECURE"
          "Could not update the watch connection. Retry or enter a new limited setup code." -> "CONNECTION_UPDATE_FAILED"
          "No certificate was received. Check the Gateway TLS endpoint." -> "NO_CERTIFICATE"
          "Gateway TLS is unavailable. Check the endpoint and retry." -> "TLS_UNAVAILABLE"
          "Full-access credentials are not accepted. Enter a new limited setup code." -> "FULL_ACCESS_REJECTED"
          "Gateway connection failed. Check connectivity or enter a new limited setup code." -> "CONNECTION_FAILED"
          else -> "UNKNOWN"
        },
      )
    }

  private fun navigationSnapshot(
    activity: MainActivity?,
    runtime: WearDirectRuntime,
  ): JsonObject {
    val state = runtime.state.value
    val interactive = app.getSystemService(PowerManager::class.java).isInteractive
    val keyguard = app.getSystemService(KeyguardManager::class.java)
    val showing = keyguard.isKeyguardLocked
    val locked = keyguard.isDeviceLocked
    val lifecycle = activity?.lifecycle?.currentState?.name ?: "UNKNOWN"
    val focused = activity?.hasWindowFocus() == true
    // These non-atomic facts avoid accessibility queries and screenshots, which
    // can add hidden waits. Compose's local management state stays unknown.
    return buildJsonObject {
      put("elapsedRealtimeMs", SystemClock.elapsedRealtime())
      put("screenInteractive", interactive)
      put("keyguardShowing", showing)
      put("deviceLocked", locked)
      put("activityLifecycle", lifecycle)
      put("activityFocused", focused)
      put("selected", state.selected != null)
      put("busy", state.busy)
      put("trust", state.trust != null)
      put("managementRequired", state.connectionManagementRequired)
      put("composeManage", "UNKNOWN")
    }
  }

  private fun clickAction(
    activity: MainActivity,
    label: String,
    allowScroll: Boolean = true,
    beforeClick: () -> Unit = {},
  ) {
    var firstMatch: JsonObject? = null
    var terminal: JsonObject? = null
    var queryIndex = 0
    var scrollIndex = 0
    var diagnosticIncomplete = false

    fun flags(node: AccessibilityNodeInfo): JsonObject? =
      runCatching {
        // These getters read the acquired node's fields; never refresh for diagnostics.
        buildJsonObject {
          put("enabled", node.isEnabled)
          put("visible", node.isVisibleToUser)
          put("clickable", node.isClickable)
          put("actionClick", node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK })
        }
      }.onFailure { diagnosticIncomplete = true }.getOrNull()

    val display = Rect(0, 0, device.displayWidth, device.displayHeight)
    val root = requireNotNull(instrumentation.uiAutomation.rootInActiveWindow)
    try {
      val window = requireNotNull(root.window)
      try {
        val windowBounds = Rect().also { window.getBoundsInScreen(it) }
        val rootBounds = Rect().also { root.getBoundsInScreen(it) }
        assertTrue(
          "action belongs to the active default-display application window",
          root.packageName?.toString() == app.packageName && window.id == root.windowId &&
            window.type == AccessibilityWindowInfo.TYPE_APPLICATION && window.isActive && window.isFocused &&
            window.displayId == Display.DEFAULT_DISPLAY && rootBounds == windowBounds &&
            windowBounds.left == 0 && windowBounds.top == 0 && !windowBounds.isEmpty &&
            display.contains(windowBounds),
        )

        fun actionPoint(): Point? {
          val lookupIndex = queryIndex++
          val lookupScrollIndex = scrollIndex
          var matchCount: Int? = null
          var ownerCount: Int? = null
          var selfFlags: JsonObject? = null
          var parentFlags: JsonObject? = null
          var boundsIntersected: Boolean? = null
          var scrollViewportIntersected: Boolean? = null
          var rootReached: Boolean? = null
          val currentRoot = requireNotNull(instrumentation.uiAutomation.rootInActiveWindow)
          val matches = mutableListOf<UiObject2>()
          val acquired = mutableListOf<AccessibilityNodeInfo>()
          try {
            val currentWindow = requireNotNull(currentRoot.window)
            try {
              val currentBounds = Rect().also { currentWindow.getBoundsInScreen(it) }
              val currentRootBounds = Rect().also { currentRoot.getBoundsInScreen(it) }
              assertTrue(
                "action lookup remains in the verified application window",
                currentRoot.packageName?.toString() == app.packageName && currentRoot.windowId == window.id &&
                  currentWindow.id == window.id && currentWindow.type == AccessibilityWindowInfo.TYPE_APPLICATION &&
                  currentWindow.isActive && currentWindow.isFocused && currentWindow.displayId == Display.DEFAULT_DISPLAY &&
                  currentBounds == windowBounds && currentRootBounds == windowBounds,
              )
            } finally {
              @Suppress("DEPRECATION")
              currentWindow.recycle()
            }
            matches.addAll(device.findObjects(By.pkg(app.packageName).text(label)))
            matchCount = matches.size
            val owners = linkedMapOf<AccessibilityNodeInfo, Rect>()
            for ((matchIndex, match) in matches.withIndex()) {
              val child = match.accessibilityNodeInfo
              if (matchIndex == 0) selfFlags = flags(child)
              if (child.packageName?.toString() != app.packageName || child.text?.toString() != label ||
                child.windowId != window.id || !child.isEnabled || !child.isVisibleToUser || child.isEditable || child.isPassword
              ) {
                continue
              }
              val owner = child.getParent(0)?.also { acquired.add(it) } ?: continue
              if (matchIndex == 0) parentFlags = flags(owner)
              if (owner.packageName?.toString() != app.packageName || owner.windowId != window.id ||
                !owner.isEnabled || !owner.isVisibleToUser || !owner.isClickable || owner.isEditable || owner.isPassword ||
                owner.actionList.none { it.id == AccessibilityNodeInfo.ACTION_CLICK }
              ) {
                continue
              }
              val hit = Rect().also { child.getBoundsInScreen(it) }
              val ownerBounds = Rect().also { owner.getBoundsInScreen(it) }
              val intersects = hit.intersect(ownerBounds) && hit.intersect(windowBounds) && hit.intersect(display)
              if (matchIndex == 0) boundsIntersected = intersects
              if (!intersects) continue
              // Only the immediate parent can own the action. Ancestors merely clip the
              // physical viewport; UiAutomator's visibleBounds ignores failed intersections.
              var ancestor: AccessibilityNodeInfo? = owner
              val seen = mutableSetOf<AccessibilityNodeInfo>()
              var reachedRoot = false
              while (ancestor != null) {
                val current = ancestor
                assertTrue("action viewport ancestry is acyclic", seen.add(current))
                if (current.packageName?.toString() != app.packageName || current.windowId != window.id) break
                if (current.isScrollable) {
                  val viewport = Rect().also { current.getBoundsInScreen(it) }
                  val viewportIntersects = hit.intersect(viewport)
                  if (matchIndex == 0) scrollViewportIntersected = viewportIntersects
                  if (!viewportIntersects) break
                }
                if (current == currentRoot) {
                  reachedRoot = true
                  break
                }
                ancestor = current.getParent(0)?.also { acquired.add(it) }
              }
              if (matchIndex == 0) rootReached = reachedRoot
              if (reachedRoot && !hit.isEmpty) owners.putIfAbsent(owner, hit)
            }
            ownerCount = owners.size
            assertTrue("at most one distinct eligible native action owner", owners.size <= 1)
            return owners.values.singleOrNull()?.let { Point(it.centerX(), it.centerY()) }
          } finally {
            runCatching {
              val observation =
                buildJsonObject {
                  put("queryIndex", lookupIndex)
                  put("scrollIndex", lookupScrollIndex)
                  put("matchCount", matchCount)
                  put("ownerCount", ownerCount)
                  put("self", selfFlags ?: JsonNull)
                  put("parent", parentFlags ?: JsonNull)
                  put("boundsIntersected", boundsIntersected)
                  put("scrollViewportIntersected", scrollViewportIntersected)
                  put("rootReached", rootReached)
                }
              terminal = observation
              if (firstMatch == null && (matchCount ?: 0) > 0) firstMatch = observation
            }.onFailure { diagnosticIncomplete = true }
            @Suppress("DEPRECATION")
            acquired.forEach { it.recycle() }
            matches.forEach { it.recycle() }
            @Suppress("DEPRECATION")
            currentRoot.recycle()
          }
        }

        var exposed = actionPoint() != null
        if (!exposed && allowScroll) {
          repeat(8) {
            scroll(down = false)
            scrollIndex++
          }
          repeat(20) {
            if (!exposed) {
              exposed = actionPoint() != null
              if (!exposed) {
                scroll(down = true)
                scrollIndex++
              }
            }
          }
        }
        assertTrue("one eligible native action is exposed", exposed)
        assertTrue("application stability root is current", root.refresh())
        // UiAutomator 2.4.0 crops Y to zero: use only a zero-origin full window.
        // This is library visual stability, not Compose idle or a hard end-to-end deadline.
        val stable =
          root.waitForStable(
            requireStableScreenshot = true,
            stableTimeoutMs = 3_000,
            stableIntervalMs = 500,
            stablePollIntervalMs = 50,
          )
        try {
          val bitmap = stable.screenshot
          val stableBounds = Rect().also { stable.node.getBoundsInScreen(it) }
          assertTrue(
            "full application window became visually stable",
            !stable.isTimeout && bitmap != null && stable.node.packageName?.toString() == app.packageName &&
              stable.node.windowId == window.id && stableBounds == windowBounds &&
              bitmap.width == windowBounds.width() && bitmap.height == windowBounds.height(),
          )
        } finally {
          stable.screenshot?.recycle()
        }
        // No scrolling or retained UiObject2 after stability (including after proof capture).
        val point = requireNotNull(actionPoint()) { "native action is no longer eligible after stability" }
        beforeClick()
        val resumed = activity.lifecycle.currentState == Lifecycle.State.RESUMED
        val focused = activity.hasWindowFocus()
        val interactive = app.getSystemService(PowerManager::class.java).isInteractive
        val keyguard = app.getSystemService(KeyguardManager::class.java)
        val showing = keyguard.isKeyguardLocked
        val locked = keyguard.isDeviceLocked
        assertTrue("native action requires resumed, focused, awake and unlocked application", resumed && focused && interactive && !showing && !locked)
        assertTrue("stock native action click was accepted", device.click(point.x, point.y))
      } finally {
        @Suppress("DEPRECATION")
        window.recycle()
      }
    } catch (error: Throwable) {
      runCatching {
        val failed = runCatching { navigationSnapshot(activity, app.directRuntime) }.getOrNull()
        val diagnostic =
          buildJsonObject {
            put("schema", "wear-native-action-v1")
            put("queryCount", queryIndex)
            put("scrollCount", scrollIndex)
            put("observationsIncomplete", diagnosticIncomplete)
            put("firstMatch", firstMatch ?: JsonNull)
            put("terminal", terminal ?: JsonNull)
            put("failure", failed ?: JsonNull)
          }
        val encoded = Json.encodeToString(diagnostic)
        check(encoded.toByteArray().size <= 4096)
        error.addSuppressed(AssertionError("wear-native-action:$encoded").apply { stackTrace = emptyArray() })
      }.onFailure {
        error.addSuppressed(AssertionError("wear-native-action-diagnostic-unavailable").apply { stackTrace = emptyArray() })
      }
      throw error
    } finally {
      @Suppress("DEPRECATION")
      root.recycle()
    }
  }

  private fun findText(
    text: String,
    contains: Boolean = false,
  ): UiObject2 {
    val selector = if (contains) By.textContains(text) else By.text(text)
    visible(selector)?.let { return it }
    repeat(8) { scroll(down = false) }
    repeat(20) {
      visible(selector)?.let { return it }
      scroll(down = true)
    }
    throw AssertionError("Expected native control or evidence text is not visible")
  }

  private fun visible(selector: BySelector): UiObject2? = device.findObjects(selector).firstOrNull { it.isEnabled && it.visibleBounds.height() > 12 }

  private fun scroll(down: Boolean) {
    val x = device.displayWidth / 2
    val top = device.displayHeight * 3 / 10
    val bottom = device.displayHeight * 7 / 10
    device.swipe(x, if (down) bottom else top, x, if (down) top else bottom, 12)
    device.waitForIdle()
  }

  private fun capture(
    phase: String,
    name: String,
  ) {
    val output = File(app.getExternalFilesDir(null), "direct-gateway-proof")
    assertTrue("private screenshot directory exists", output.isDirectory || output.mkdirs())
    val file = File(output, "$phase-$name.png")
    assertTrue("native screenshot is not overwritten", !file.exists())
    assertTrue("native screenshot saved for separate privacy review", device.takeScreenshot(file))
  }

  private fun awaitState(
    label: String,
    predicate: () -> Boolean,
  ) {
    val deadline = SystemClock.elapsedRealtime() + 15_000
    while (!predicate() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50)
    assertTrue(label, predicate())
    instrumentation.waitForIdleSync()
  }

  private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private fun fileSha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { stream ->
      val buffer = ByteArray(8192)
      var count = stream.read(buffer)
      while (count >= 0) {
        digest.update(buffer, 0, count)
        count = stream.read(buffer)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  @Serializable
  private data class SavedGrant(
    val deviceIdSha256: String,
    val tokenSha256: String,
  )

  @Serializable
  private class ApprovalReady(
    val runId: String,
    val nonce: String,
    val sessionKey: String,
  )

  @Serializable
  private class ApprovalInput(
    val runId: String,
    val nonce: String,
    val sessionKey: String,
    val expiresAtMs: Long,
    val id: String,
  )

  @Serializable
  private class ApprovalConfirmed(
    val runId: String,
    val nonce: String,
    val id: String,
    val decision: String,
  )

  @Serializable
  private class BackgroundReady(
    val runId: String,
    val nonce: String,
    val phase: String,
    val deviceIdSha256: String,
  )

  @Serializable
  private class ClosureInput(
    val runId: String,
    val nonce: String,
    val phase: String,
    val expiresAtMs: Long,
    val closedConnectionLogKey: String,
    val expectedSessionKey: String,
    val freshHistoryMarker: String,
    val injectionMessageId: String,
  )

  @Serializable
  private class ResumeInput(
    val runId: String,
    val nonce: String,
    val phase: String,
    val expiresAtMs: Long,
    val previousConnectionLogKey: String,
    val connectionLogKey: String,
    val requestLogKey: String,
    val method: String,
    val methodSucceeded: Boolean,
    val expectedSessionKey: String,
    val freshHistoryMarker: String,
  )

  @Serializable
  private class Teardown(
    val foregroundDisconnectSettled: Boolean,
    val activityBackgroundSettled: Boolean,
    val explicitTestCoroutineOwnerCancelled: Boolean,
    val explicitTestCoroutineOwnerJoined: Boolean,
  )

  @Serializable
  private class Checkpoint(
    val runId: String,
    val nonce: String,
    val pid: Int,
    val processStartElapsedMs: Long,
    val sourceCommit: String,
    val sourceTree: String,
    val apkSha256: String,
    val testApkSha256: String,
    val gatewayId: String,
    val certificateSha256: String,
    val grant: SavedGrant,
    val transport: ResumeInput,
    val teardown: Teardown,
  )

  @Serializable
  private class ProofInput(
    val runId: String,
    val nonce: String,
    val expiresAtMs: Long,
    val phase: String,
    val sourceCommit: String,
    val sourceTree: String,
    val apkSha256: String,
    val testApkSha256: String,
    val certificateSha256: String,
    val sessionKey: String,
    val sessionTitle: String,
    val historyMarker: String,
    val helpMarker: String,
    val approvalTitle: String,
    val setupCode: String? = null,
    val previousNonce: String? = null,
  )
}
