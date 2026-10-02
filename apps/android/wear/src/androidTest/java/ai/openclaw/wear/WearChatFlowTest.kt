package ai.openclaw.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearReplyText
import ai.openclaw.wear.shared.WearRpcMethod
import android.app.Activity
import android.app.Instrumentation
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.ViewTreeObserver
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real launcher, input-result callback, ViewModel and wire decoder; only Phone IO is controlled. */
@RunWith(AndroidJUnit4::class)
class WearChatFlowTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val device = UiDevice.getInstance(instrumentation)
  private val failures = mutableListOf<String>()
  private val output by lazy {
    File(instrumentation.targetContext.getExternalFilesDir(null), "chat-flow").apply { mkdirs() }
  }

  @Test
  fun completeReplyIsReachableThroughTheRealLauncherAndWireDecoder() {
    val full = "HEAD SENTINEL\n" + (1..85).joinToString("\n") { "Reply line $it is complete." } + "\nTRAILING SENTINEL"
    val phone = ControlledPhone(full)
    val app = instrumentation.targetContext.applicationContext as WearApplication
    val clientField = WearApplication::class.java.getDeclaredField("proxyClient\$delegate").apply { isAccessible = true }
    val repositoryField = WearApplication::class.java.getDeclaredField("gatewayRepository\$delegate").apply { isAccessible = true }
    val previousClient = clientField.get(app)
    val previousRepository = repositoryField.get(app)
    clientField.set(app, lazyOf(phone.client))
    repositoryField.set(app, lazyOf(WearGatewayRepository(phone.client)))
    WearSettingsStore(app).writeThemeMode(WearThemeMode.Dark)
    WearSettingsStore(app).writeAutoSpeak(false)
    var activity: MainActivity? = null
    try {
      activity = instrumentation.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
      awaitState("history") { phone.historyResponses.get() > 0 }
      scrollToTop()
      awaitState("reply preview") { device.hasObject(By.textContains("HEAD SENTINEL")) }
      assertTrue(!device.hasObject(By.textContains("TRAILING SENTINEL")))
      capture("full-01-preview")

      fun reveal(text: String) {
        repeat(100) {
          val node = device.findObject(By.text(text))
          if (node != null && node.visibleBounds.centerY() in 70..300) return
          device.swipe(192, 290, 192, 100, 8)
          SystemClock.sleep(100)
        }
        assertTrue("Reachable $text", false)
      }
      reveal("Read full reply")
      device.findObject(By.text("Read full reply")).click()
      assertTrue(device.wait(Until.hasObject(By.text("HEAD SENTINEL")), 10_000))
      capture("full-02-open")
      reveal("TRAILING SENTINEL")
      capture("full-03-tail")
      assertTrue(device.hasObject(By.text("TRAILING SENTINEL")))
      device.pressBack()
      assertTrue(device.wait(Until.hasObject(By.text("Read full reply")), 5_000))
    } finally {
      activity?.let { current -> instrumentation.runOnMainSync { current.finish() } }
      instrumentation.waitForIdleSync()
      clientField.set(app, previousClient)
      repositoryField.set(app, previousRepository)
    }
  }

  @Test
  fun remoteTerminalsAndCanonicalReplacements() {
    val phone = ControlledPhone()
    val app = instrumentation.targetContext.applicationContext as WearApplication
    // Reuse the existing production transport seam, without a new runtime/fixture owner.
    val clientField = WearApplication::class.java.getDeclaredField("proxyClient\$delegate")
    clientField.isAccessible = true
    val previousClient = clientField.get(app)
    clientField.set(app, lazyOf(phone.client))
    val repositoryField = WearApplication::class.java.getDeclaredField("gatewayRepository\$delegate")
    repositoryField.isAccessible = true
    val previousRepository = repositoryField.get(app)
    repositoryField.set(app, lazyOf(WearGatewayRepository(phone.client)))
    WearSettingsStore(app).writeThemeMode(WearThemeMode.Dark)
    WearSettingsStore(app).writeAutoSpeak(false)
    val monitor =
      object : Instrumentation.ActivityMonitor() {
        override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
          val result = Intent()
          RemoteInput.addResultsToIntent(
            arrayOf(RemoteInput.Builder(REPLY_RESULT_KEY).setLabel("Message").build()),
            result,
            Bundle().apply { putCharSequence(REPLY_RESULT_KEY, "Hello") },
          )
          return Instrumentation.ActivityResult(Activity.RESULT_OK, result)
        }
      }
    var activity: MainActivity? = null
    try {
      activity =
        instrumentation.startActivitySync(
          Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        ) as MainActivity
      awaitState("initial history") { phone.historyResponses.get() > 0 }
      scrollToTop()
      awaitState("initial connected UI") { device.hasObject(By.text("Ready")) }
      instrumentation.addMonitor(monitor)
      capture("00-ready")
      for (terminal in listOf("aborted", "error")) {
        scrollToAction("Type")
        val priorSends = phone.sends
        device.findObject(By.text("Type")).click()
        awaitState("accepted send") { phone.sends == priorSends + 1 }
        assertTrue("real input callback sends Hello", phone.lastMessage == "Hello")
        scrollToTop()
        awaitState("accepted reply UI") { device.hasObject(By.text("Sending")) || device.hasObject(By.text("Agent working")) }
        capture("$terminal-01-accepted")
        renderAfter(activity) { phone.emit("error", runId = "older-run") }
        capture("$terminal-02-foreign")
        // A stale foreign terminal must not settle the newly accepted reply.
        checkUi("$terminal foreign terminal preserves pending reply", device.hasObject(By.text("Sending")) || device.hasObject(By.text("Agent working")))
        val beforeTerminalHistory = phone.historyResponses.get()
        phone.emit(terminal)
        awaitState("remote terminal history response") { phone.historyResponses.get() > beforeTerminalHistory }
        scrollToTop()
        val outcome = if (terminal == "error") "Error" else "Ready"
        awaitState("remote terminal UI") {
          device.hasObject(By.text(outcome)) && !device.hasObject(By.text("Sending")) && device.hasObject(By.text("Start a conversation"))
        }
        capture("$terminal-03-terminal")
        checkUi("$terminal settles Sending with unchanged history", !device.hasObject(By.text("Sending")))
        checkUi("$terminal visible outcome", device.hasObject(By.text(outcome)))
        checkUi("empty controlled history produces no assistant", device.hasObject(By.text("Start a conversation")))
        val beforeExplicitHistory = phone.historyResponses.get()
        refreshFromControls()
        awaitState("explicit refresh history response") { phone.historyResponses.get() > beforeExplicitHistory }
        scrollToTop()
        awaitState("explicit refresh UI") { device.hasObject(By.text(outcome)) && !device.hasObject(By.text("Sending")) }
        capture("$terminal-04-refreshed")
        checkUi("$terminal outcome survives refresh", device.hasObject(By.text(outcome)))
      }
      phone.emit("delta", runId = "stream-run", text = "Hello world")
      awaitState("canonical stream UI") { device.hasObject(By.text("Hello world")) }
      capture("stream-01-world")
      phone.emit("delta", runId = "stream-run", text = "Hello")
      awaitState("canonical stream shrinks") { device.hasObject(By.text("Hello")) && !device.hasObject(By.text("Hello world")) }
      capture("stream-02-shrink")
      checkUi("ordered canonical replacement shrinks", device.hasObject(By.text("Hello")) && !device.hasObject(By.text("Hello world")))
      phone.emit("delta", runId = "stream-run", text = "")
      scrollToTop()
      awaitState("canonical stream clears") { !device.hasObject(By.text("Hello")) && device.hasObject(By.text("Start a conversation")) }
      capture("stream-03-clear")
      checkUi("ordered canonical replacement clears", !device.hasObject(By.text("Hello")) && device.hasObject(By.text("Start a conversation")))
      File(output, "assertions.txt").writeText(if (failures.isEmpty()) "PASS\n" else failures.joinToString("\n"))
      assertEquals("Regression invariants", emptyList<String>(), failures)
    } finally {
      instrumentation.removeMonitor(monitor)
      activity?.let { current -> instrumentation.runOnMainSync { current.finish() } }
      instrumentation.waitForIdleSync()
      clientField.set(app, previousClient)
      repositoryField.set(app, previousRepository)
    }
  }

  private fun checkUi(
    label: String,
    passed: Boolean,
  ) {
    if (!passed) failures += label
  }

  private fun renderAfter(
    activity: MainActivity,
    event: () -> Unit,
  ) {
    val rendered = CountDownLatch(1)
    val view = activity.window.decorView
    val listener = ViewTreeObserver.OnDrawListener { view.post { rendered.countDown() } }
    instrumentation.runOnMainSync {
      // A foreign terminal intentionally has no history response to use as a barrier.
      event()
      view.viewTreeObserver.addOnDrawListener(listener)
      view.postInvalidateOnAnimation()
    }
    try {
      assertTrue("event reached a real UI draw", rendered.await(15, TimeUnit.SECONDS))
      instrumentation.waitForIdleSync()
    } finally {
      instrumentation.runOnMainSync { view.viewTreeObserver.removeOnDrawListener(listener) }
    }
  }

  private fun scrollToAction(label: String) {
    repeat(6) {
      val button = device.findObject(By.text(label))
      if (button != null && button.isEnabled && button.visibleBounds.height() > 12) return
      device.swipe(190, 290, 190, 130, 12)
      SystemClock.sleep(200)
    }
    assertTrue("$label action is reachable", device.wait(Until.hasObject(By.text(label)), 3_000))
  }

  private fun refreshFromControls() {
    // The connection host owns the real UI's ViewModel; drive its refresh through the pager.
    repeat(2) {
      device.swipe(300, 190, 80, 190, 12)
      device.waitForIdle()
    }
    scrollToAction("Refresh")
    device.findObject(By.text("Refresh")).click()
    repeat(2) {
      device.swipe(80, 190, 300, 190, 12)
      device.waitForIdle()
    }
  }

  private fun scrollToTop() {
    repeat(5) { device.swipe(190, 135, 190, 300, 12) }
    SystemClock.sleep(500)
  }

  private fun capture(name: String) {
    SystemClock.sleep(900)
    assertTrue(device.takeScreenshot(File(output, "$name.png")))
    device.dumpWindowHierarchy(File(output, "$name.xml"))
  }

  private fun awaitState(
    label: String,
    predicate: () -> Boolean,
  ) {
    val deadline = SystemClock.elapsedRealtime() + 15_000
    while (!predicate() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50)
    assertTrue(label, predicate())
    instrumentation.waitForIdleSync()
    SystemClock.sleep(300)
  }

  private class ControlledPhone(
    private val fullReply: String? = null,
  ) {
    @Volatile var sequence = 0L

    @Volatile var sends = 0

    @Volatile var runId = "not-sent"

    @Volatile var lastMessage: String? = null
    val historyResponses = AtomicInteger()
    val client: WearProxyClient =
      WearProxyClient.createForTests(
        nodeResolver = WearNodeResolver { "synthetic-phone" },
        transport = WearMessageTransport { _, path, bytes -> respond(path, bytes) },
      )

    private suspend fun respond(
      path: String,
      bytes: ByteArray,
    ) {
      assertEquals(WearProtocol.REQUEST_PATH, path)
      val request = (WearProtocolCodec.decode(bytes) as WearDecodeResult.Success).message as WearMessage.Request
      val result =
        when (request.method) {
          WearRpcMethod.ProxyStatus -> {
            Json.parseToJsonElement("""{"connected":true,"activeAgentId":"main","activeSessionKey":"agent:main:proof","selectedModelRef":"openai/gpt-4o","capabilities":["reply-text"]}""")
          }

          WearRpcMethod.SessionsList -> {
            Json.parseToJsonElement("""{"sessions":[{"key":"agent:main:proof","displayName":"Test chat","agentId":"main","modelRef":"openai/gpt-4o","hasActiveRun":false}]}""")
          }

          WearRpcMethod.ReplyText -> {
            WearReplyText.encode(
              WearReplyText.page(
                checkNotNull(fullReply),
                "native-proof",
                request.params
                  .getValue("offset")
                  .jsonPrimitive.content
                  .toInt(),
                request.params["revision"]?.jsonPrimitive?.content,
              ),
            )
          }

          WearRpcMethod.ChatHistory -> {
            if (fullReply != null) {
              buildJsonObject {
                put("sessionKey", "agent:main:proof")
                put(
                  "messages",
                  kotlinx.serialization.json.buildJsonArray {
                    add(
                      buildJsonObject {
                        put("id", "row")
                        put("entryId", "canonical")
                        put("role", "assistant")
                        put("content", fullReply.take(250))
                        put("textTruncated", true)
                      },
                    )
                  },
                )
              }
            } else {
              Json.parseToJsonElement("""{"sessionKey":"agent:main:proof","messages":[],"selectedModelRef":"openai/gpt-4o"}""")
            }
          }

          WearRpcMethod.ChatSend -> {
            runId =
              request.params
                .getValue("idempotencyKey")
                .jsonPrimitive.content
            lastMessage =
              request.params
                .getValue("message")
                .jsonPrimitive.content
            sends += 1
            buildJsonObject {
              put("runId", runId)
              put("status", "started")
            }
          }

          else -> {
            error("Unexpected controlled IO: " + request.method)
          }
        }
      client.handleMessage(
        "synthetic-phone",
        WearProtocol.RESPONSE_PATH,
        WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true, result = result, eventStreamId = "proof-epoch", eventSequence = sequence)),
      )
      if (request.method == WearRpcMethod.ChatHistory) historyResponses.incrementAndGet()
    }

    fun emit(
      state: String,
      runId: String = this.runId,
      text: String? = null,
    ) = runBlocking {
      sequence += 1
      val payload: JsonObject =
        buildJsonObject {
          put("sessionKey", "agent:main:proof")
          put("runId", runId)
          put("state", state)
          if (text != null) {
            put("streamText", text)
            put("streamTextComplete", true)
          }
        }
      client.handleMessage(
        "synthetic-phone",
        WearProtocol.EVENT_PATH,
        WearProtocolCodec.encode(WearMessage.Event(sequence = sequence, event = WearEventType.Chat, payload = payload, streamId = "proof-epoch")),
      )
    }
  }
}
