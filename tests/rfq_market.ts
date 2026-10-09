import anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { expect } from "chai";
import type { RfqMarket } from "../idl/rfq_market.js";
import { pdas, sha256 } from "../lib/common.js";

const { AnchorProvider, BN, Program, setProvider, workspace } = anchor;

describe("rfq_market", () => {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.RfqMarket as anchor.Program<RfqMarket>;
  const conn = provider.connection;
  const P = pdas(program.programId);
  const authority = (provider.wallet as anchor.Wallet).payer;

  const buyer = Keypair.generate();
  const sellerA = Keypair.generate();
  const sellerB = Keypair.generate();
  const stranger = Keypair.generate();
  const treasuryOwner = Keypair.generate();
  let mint: PublicKey;
  let buyerUsdc: PublicKey;
  let strangerUsdc: PublicKey;
  let treasury: PublicKey;
  let nonce = 0n;

  const now = () => Math.floor(Date.now() / 1000);
  const spec = JSON.stringify({ category: "market-data", fields: ["endpoint_count", "host_count"], freshness_hours: 24 });

  async function airdrop(pk: PublicKey) {
    const sig = await conn.requestAirdrop(pk, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }

  async function postRfq(maxPrice: number, deadlineIn: number) {
    nonce += 1n;
    const rfq = P.rfq(buyer.publicKey, nonce);
    await program.methods
      .postRfq(new BN(nonce.toString()), [...sha256(spec)], "http://indexer/specs/x", new BN(maxPrice), new BN(now() + deadlineIn))
      .accountsPartial({ buyer: buyer.publicKey })
      .signers([buyer])
      .rpc();
    return rfq;
  }

  async function quote(rfq: PublicKey, seller: Keypair, price: number) {
    const uri = `http://seller/${seller.publicKey.toBase58().slice(0, 6)}/q/${rfq.toBase58()}`;
    await program.methods
      .submitQuote(new BN(price), [...sha256(uri)], uri, new BN(now() + 3600))
      .accountsPartial({ seller: seller.publicKey, rfq })
      .signers([seller])
      .rpc();
    return P.quote(rfq, seller.publicKey);
  }

  async function expectErr(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (e: any) {
      const msg = String(e?.error?.errorCode?.code ?? e?.message ?? e);
      expect(msg).to.contain(code);
      return;
    }
    expect.fail(`expected error ${code}`);
  }

  before(async () => {
    await Promise.all([buyer, sellerA, sellerB, stranger, treasuryOwner].map((k) => airdrop(k.publicKey)));
    mint = await createMint(conn, authority, authority.publicKey, null, 6);
    buyerUsdc = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, buyer.publicKey)).address;
    strangerUsdc = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, stranger.publicKey)).address;
    treasury = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, treasuryOwner.publicKey)).address;
    await mintTo(conn, authority, mint, buyerUsdc, authority, 10_000_000);
    await mintTo(conn, authority, mint, strangerUsdc, authority, 10_000_000);

    await program.methods
      .initialize(100, mint, treasury)
      .accountsPartial({ authority: authority.publicKey, usdcMint: mint, treasury })
      .rpc();
    const cfg = await program.account.config.fetch(P.config());
    expect(cfg.feeBps).to.eq(100);
    expect(cfg.treasury.toBase58()).to.eq(treasury.toBase58());
  });

  it("happy path: post → 2 quotes → award cheapest (fee) → record_fulfillment", async () => {
    const rfq = await postRfq(100_000, 60);
    const qA = await quote(rfq, sellerA, 80_000);
    const qB = await quote(rfq, sellerB, 50_000);

    const quotes = await program.account.quote.all([{ memcmp: { offset: 8, bytes: rfq.toBase58() } }]);
    expect(quotes).to.have.length(2);
    const cheapest = quotes.sort((a, b) => a.account.price.cmp(b.account.price))[0];
    expect(cheapest.publicKey.toBase58()).to.eq(qB.toBase58());

    const before = (await getAccount(conn, treasury)).amount;
    const buyerBefore = (await getAccount(conn, buyerUsdc)).amount;
    await program.methods
      .award()
      .accountsPartial({ buyer: buyer.publicKey, rfq, quote: qB, buyerUsdc, treasury, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([buyer])
      .rpc();
    const after = (await getAccount(conn, treasury)).amount;
    const buyerAfter = (await getAccount(conn, buyerUsdc)).amount;
    expect(after - before).to.eq(500n); // 50_000 * 100 / 10_000
    expect(buyerBefore - buyerAfter).to.eq(500n);

    let r = await program.account.rfq.fetch(rfq);
    expect(r.status).to.eq(1);
    expect(r.awardedQuote!.toBase58()).to.eq(qB.toBase58());

    // the losing quote cannot be used to fulfil
    await expectErr(
      program.methods
        .recordFulfillment([...Buffer.alloc(64, 7)], [...sha256("x")])
        .accountsPartial({ buyer: buyer.publicKey, rfq, quote: qA })
        .signers([buyer])
        .rpc(),
      "QuoteMismatch",
    );

    const paymentSig = Buffer.alloc(64, 9);
    const respHash = sha256('{"endpoint_count":1}');
    await program.methods
      .recordFulfillment([...paymentSig], [...respHash])
      .accountsPartial({ buyer: buyer.publicKey, rfq, quote: qB })
      .signers([buyer])
      .rpc();
    r = await program.account.rfq.fetch(rfq);
    expect(r.status).to.eq(2);
    const f = await program.account.fulfillment.fetch(P.fulfillment(rfq));
    expect(Buffer.from(f.paymentSig).equals(paymentSig)).to.eq(true);
    expect(Buffer.from(f.responseHash).equals(respHash)).to.eq(true);
    expect(f.quote.toBase58()).to.eq(qB.toBase58());
  });

  it("rejects a quote above max_price", async () => {
    const rfq = await postRfq(100_000, 60);
    await expectErr(quote(rfq, sellerA, 100_001), "PriceAboveMax");
  });

  it("rejects a quote after the deadline", async () => {
    const rfq = await postRfq(100_000, 2);
    await new Promise((r) => setTimeout(r, 4000));
    await expectErr(quote(rfq, sellerA, 10_000), "DeadlinePassed");
  });

  it("rejects a quote after the RFQ is awarded", async () => {
    const rfq = await postRfq(100_000, 60);
    const qA = await quote(rfq, sellerA, 70_000);
    await program.methods
      .award()
      .accountsPartial({ buyer: buyer.publicKey, rfq, quote: qA, buyerUsdc, treasury, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([buyer])
      .rpc();
    await expectErr(quote(rfq, sellerB, 60_000), "RfqNotOpen");
  });

  it("rejects award by anyone other than the buyer", async () => {
    const rfq = await postRfq(100_000, 60);
    const qA = await quote(rfq, sellerA, 70_000);
    await expectErr(
      program.methods
        .award()
        .accountsPartial({ buyer: stranger.publicKey, rfq, quote: qA, buyerUsdc: strangerUsdc, treasury, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([stranger])
        .rpc(),
      "NotBuyer",
    );
  });

  it("rejects award with a treasury that is not the configured one", async () => {
    const rfq = await postRfq(100_000, 60);
    const qA = await quote(rfq, sellerA, 70_000);
    await expectErr(
      program.methods
        .award()
        .accountsPartial({ buyer: buyer.publicKey, rfq, quote: qA, buyerUsdc, treasury: strangerUsdc, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([buyer])
        .rpc(),
      "TreasuryMismatch",
    );
  });

  it("cancel_rfq only while open, and only by the buyer", async () => {
    const rfq = await postRfq(100_000, 60);
    await expectErr(
      program.methods.cancelRfq().accountsPartial({ buyer: stranger.publicKey, rfq }).signers([stranger]).rpc(),
      "NotBuyer",
    );
    await program.methods.cancelRfq().accountsPartial({ buyer: buyer.publicKey, rfq }).signers([buyer]).rpc();
    expect((await program.account.rfq.fetch(rfq)).status).to.eq(3);
    await expectErr(quote(rfq, sellerA, 10_000), "RfqNotOpen");
    await expectErr(
      program.methods.cancelRfq().accountsPartial({ buyer: buyer.publicKey, rfq }).signers([buyer]).rpc(),
      "RfqNotOpen",
    );
  });

  it("a seller can only quote once per RFQ (PDA)", async () => {
    const rfq = await postRfq(100_000, 60);
    await quote(rfq, sellerA, 70_000);
    try {
      await quote(rfq, sellerA, 60_000);
      expect.fail("second quote should fail");
    } catch (e: any) {
      expect(String(e)).to.match(/already in use|custom program error: 0x0/);
    }
  });

});
