//! One acknowledged message each way; IPC demultiplexing never waits for Gateway consumption.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{Sink, Stream};
use openclaw_gateway_client::{
    ClientError, GatewayWebSocket, GatewayWebSocketConnector, WebSocketError, WebSocketMessage,
    WebSocketRequest,
};
use serde_json::{json, Value};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::sync::{mpsc, oneshot};

type Acknowledgement = Arc<Mutex<Option<(u64, oneshot::Sender<bool>)>>>;

pub struct NativeTransport {
    incoming: mpsc::Receiver<WebSocketMessage>,
    outgoing: mpsc::Sender<Value>,
    receipts: mpsc::Sender<Value>,
    acknowledgement: Acknowledgement,
    pending: Option<oneshot::Receiver<bool>>,
    ping: Option<WebSocketMessage>,
    pong: Option<WebSocketMessage>,
    sequence: u64,
}

pub struct NativeTransportInput {
    incoming: mpsc::Sender<WebSocketMessage>,
    acknowledgement: Acknowledgement,
}

impl NativeTransport {
    pub fn new(
        outgoing: mpsc::Sender<Value>,
        receipts: mpsc::Sender<Value>,
    ) -> (Self, NativeTransportInput) {
        let (incoming_tx, incoming) = mpsc::channel(1);
        let acknowledgement = Arc::new(Mutex::new(None));
        (
            Self {
                incoming,
                outgoing,
                receipts,
                acknowledgement: acknowledgement.clone(),
                pending: None,
                ping: None,
                pong: None,
                sequence: 0,
            },
            NativeTransportInput {
                incoming: incoming_tx,
                acknowledgement,
            },
        )
    }
}

impl NativeTransportInput {
    pub fn receive(&self, kind: &str, data: &str) -> Result<(), &'static str> {
        if data.len() > super::GATEWAY_PAYLOAD_LIMIT.div_ceil(3) * 4 {
            return Err("transport frame too large");
        }
        let data = STANDARD
            .decode(data)
            .map_err(|_| "invalid transport bytes")?;
        if data.len() > super::GATEWAY_PAYLOAD_LIMIT {
            return Err("transport frame too large");
        }
        let message = match kind {
            "text" => WebSocketMessage::Text(
                String::from_utf8(data)
                    .map_err(|_| "invalid text frame")?
                    .into(),
            ),
            "binary" => WebSocketMessage::Binary(data.into()),
            _ => return Err("invalid transport message kind"),
        };
        self.incoming
            .try_send(message)
            .map_err(|_| "unacknowledged transport frame")
    }

    pub fn acknowledge(&self, id: u64, ok: bool) -> Result<(), &'static str> {
        let (expected, reply) = self
            .acknowledgement
            .lock()
            .unwrap()
            .take()
            .ok_or("unexpected transport receipt")?;
        if expected != id {
            return Err("transport receipt mismatch");
        }
        reply.send(ok).map_err(|_| "transport closed")
    }
}

impl Drop for NativeTransportInput {
    fn drop(&mut self) {
        self.acknowledgement.lock().unwrap().take();
    }
}

fn closed() -> WebSocketError {
    WebSocketError::ConnectionClosed
}

impl Stream for NativeTransport {
    type Item = Result<WebSocketMessage, WebSocketError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some(pong) = self.pong.take() {
            return Poll::Ready(Some(Ok(pong)));
        }
        match self.incoming.poll_recv(cx) {
            Poll::Ready(Some(message)) => {
                // The native peer cannot read its next network message before this receipt.
                if self
                    .receipts
                    .try_send(json!({"type":"transport-received"}))
                    .is_err()
                {
                    return Poll::Ready(Some(Err(closed())));
                }
                Poll::Ready(Some(Ok(message)))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Sink<WebSocketMessage> for NativeTransport {
    type Error = WebSocketError;
    fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.poll_flush(cx)
    }
    fn start_send(mut self: Pin<&mut Self>, message: WebSocketMessage) -> Result<(), Self::Error> {
        if self.pending.is_some() {
            return Err(closed());
        }
        let (kind, data) = match message {
            WebSocketMessage::Text(text) => ("text", text.as_bytes().to_vec()),
            WebSocketMessage::Ping(bytes) => {
                self.ping = Some(WebSocketMessage::Pong(bytes));
                ("ping", Vec::new())
            }
            WebSocketMessage::Close(_) => ("close", Vec::new()),
            // URLSession owns unsolicited WebSocket ping/pong responses.
            WebSocketMessage::Pong(_) => return Ok(()),
            _ => return Err(closed()),
        };
        if data.len() > super::GATEWAY_PAYLOAD_LIMIT {
            return Err(closed());
        }
        self.sequence = self.sequence.checked_add(1).ok_or_else(closed)?;
        let (reply, receive) = oneshot::channel();
        *self.acknowledgement.lock().unwrap() = Some((self.sequence, reply));
        self.pending = Some(receive);
        self.outgoing
            .try_send(json!({"type":"transport-send", "id":self.sequence,
            "kind":kind,"data":STANDARD.encode(data)}))
            .map_err(|_| closed())
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let Some(pending) = self.pending.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        match Pin::new(pending).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Ok(true)) => {
                self.pending = None;
                self.pong = self.ping.take();
                Poll::Ready(Ok(()))
            }
            Poll::Ready(_) => {
                self.pending = None;
                Poll::Ready(Err(closed()))
            }
        }
    }
    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // Closing the product session retires both the helper and the URLSession task.
        self.incoming.close();
        self.poll_flush(cx)
    }
}

pub struct NativeConnector(Mutex<Option<NativeTransport>>);
impl NativeConnector {
    pub fn new(transport: NativeTransport) -> Self {
        Self(Mutex::new(Some(transport)))
    }
}
impl std::fmt::Debug for NativeConnector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeConnector")
    }
}
impl GatewayWebSocketConnector for NativeConnector {
    fn connect(
        &self,
        _: WebSocketRequest<()>,
        _: usize,
    ) -> futures_util::future::BoxFuture<'static, Result<Box<dyn GatewayWebSocket>, ClientError>>
    {
        let socket = self.0.lock().unwrap().take();
        Box::pin(async move {
            socket
                .map(|socket| Box::new(socket) as Box<dyn GatewayWebSocket>)
                .ok_or_else(|| ClientError::Closed("native transport already consumed".into()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};

    #[tokio::test]
    async fn duplex_receipts_do_not_wait_for_the_gateway_receive_loop() {
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, mut acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        native
            .receive("text", &STANDARD.encode("challenge"))
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "challenge"
        );
        assert_eq!(
            acknowledgements.recv().await.unwrap()["type"],
            "transport-received"
        );
        // The Gateway can answer immediately, before URLSession reports the write complete.
        // Delivering that response must not consume or obstruct the independent write receipt.
        let mut send = Box::pin(socket.send(WebSocketMessage::Text("connect".into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let write = writes.recv().await.unwrap();
        native.receive("text", &STANDARD.encode("hello")).unwrap();
        native
            .acknowledge(write["id"].as_u64().unwrap(), true)
            .unwrap();
        send.await.unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "hello"
        );
    }

    #[tokio::test]
    async fn native_input_is_bounded_and_closure_releases_pending_work() {
        let (outgoing, _writes) = mpsc::channel(1);
        let (receipts, _acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        native.receive("text", &STANDARD.encode("one")).unwrap();
        assert!(native.receive("text", &STANDARD.encode("two")).is_err());
        let mut send = Box::pin(socket.send(WebSocketMessage::Text("pending".into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        // EOF from the authenticated native reader retires the sole write acknowledgement.
        drop(native);
        assert!(send.await.is_err());
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "one"
        );
        assert!(socket.next().await.is_none());
    }

    #[tokio::test]
    async fn full_gateway_payload_survives_base64_relay_and_oversize_is_rejected() {
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, mut acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        let text = "/".repeat(super::super::GATEWAY_PAYLOAD_LIMIT);
        let mut send = Box::pin(socket.send(WebSocketMessage::Text(text.clone().into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let value = writes.recv().await.unwrap();
        assert!(
            serde_json::to_vec(&value).unwrap().len() + 65 <= super::super::FRAME_LIMIT as usize
        );
        let encoded = value["data"].as_str().unwrap();
        native.receive("text", encoded).unwrap();
        native
            .acknowledge(value["id"].as_u64().unwrap(), true)
            .unwrap();
        send.await.unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            text
        );
        acknowledgements.recv().await.unwrap();
        assert!(native
            .receive(
                "binary",
                &STANDARD.encode(vec![0; super::super::GATEWAY_PAYLOAD_LIMIT + 1])
            )
            .is_err());
        native
            .receive("text", &STANDARD.encode("still-alive"))
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "still-alive"
        );
    }
}
