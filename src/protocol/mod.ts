import { assert, BufReader, Deferred, deferred } from "../../deps.ts";
import { Document } from "../types.ts";
import { handshake } from "./handshake.ts";
import { parseHeader } from "./header.ts";
import { deserializeMessage, Message, serializeMessage } from "./message.ts";

type Socket = Deno.Reader & Deno.Writer;

let nextRequestId = 0;

export class WireProtocol {
  #socket: Socket;
  #pending = false;
  #pendingOps: Map<number, Deferred<Message>> = new Map();
  #reader: BufReader;

  constructor(socket: Socket) {
    this.#socket = socket;
    this.#reader = new BufReader(this.#socket);
  }

  async connect() {
    await handshake(this);
  }

  async command(db: string, body: Document) {
    const requestId = nextRequestId++;
    const chunks = serializeMessage({
      requestId,
      responseTo: 0,
      sections: [
        {
          document: {
            ...body,
            $db: db,
          },
        },
      ],
    });

    for (const chunk of chunks) {
      await Deno.writeAll(this.#socket, chunk);
    }

    this.#pendingOps.set(requestId, deferred());
    this.receive();
    const message = await this.#pendingOps.get(requestId);

    let documents: Document[] = [];

    message?.sections.forEach((section) => {
      if ("document" in section) {
        documents.push(section.document);
      } else {
        documents = documents.concat(section.documents);
      }
    });

    return documents;
  }

  private async receive() {
    if (this.#pending) return;
    this.#pending = true;
    while (this.#pendingOps.size > 0) {
      const headerBuffer = await this.#reader.readFull(new Uint8Array(16));
      assert(headerBuffer);
      const header = parseHeader(headerBuffer!);
      const bodyBuffer = await this.#reader.readFull(
        new Uint8Array(header.messageLength - 16),
      );
      assert(bodyBuffer);
      const reply = deserializeMessage(header, bodyBuffer!);
      const pendingMessage = this.#pendingOps.get(header.responseTo);
      this.#pendingOps.delete(header.responseTo);
      pendingMessage?.resolve(reply);
    }
    this.#pending = false;
  }
}