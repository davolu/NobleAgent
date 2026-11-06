import { z } from "zod";
import { defineTool } from "noble-agent";

// Toy order "database" for the example.
const ORDERS: Record<string, { id: string; item: string; status: string; totalEur: number }> = {
  "A-1001": { id: "A-1001", item: "Acme Blender Pro", status: "delivered", totalEur: 89 },
  "A-1002": { id: "A-1002", item: "Acme Mixer Mini", status: "in transit", totalEur: 45 },
};

export const lookupOrder = defineTool(
  {
    name: "lookupOrder",
    description: "Look up an order by its id (e.g. A-1001). Returns item, status and total.",
    params: z.object({ orderId: z.string() }),
  },
  async ({ orderId }) => ORDERS[orderId] ?? { error: `No order ${orderId} found.` }
);

/** Side effect (name-inferred): always pauses for human approval. */
export const refundOrder = defineTool(
  {
    name: "refundOrder",
    description: "Refund an order to the original payment method. Requires the order id.",
    params: z.object({ orderId: z.string(), reason: z.string() }),
  },
  async ({ orderId }) => {
    const order = ORDERS[orderId];
    if (!order) return { error: `No order ${orderId} found.` };
    return { refunded: true, orderId, amountEur: order.totalEur };
  }
);

export const tools = [lookupOrder, refundOrder];
