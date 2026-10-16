use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp");

pub const MAX_URI_LEN: usize = 200;
pub const MAX_HOST_LEN: usize = 100;
pub const MAX_PAY_TO_LEN: usize = 64;
pub const MAX_NETWORK_LEN: usize = 64;
pub const MAX_FEE_BPS: u16 = 10_000;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_AWARDED: u8 = 1;
pub const STATUS_FULFILLED: u8 = 2;
pub const STATUS_CANCELLED: u8 = 3;
#[allow(dead_code)]
pub const STATUS_EXPIRED: u8 = 4;
pub const STATUS_REJECTED: u8 = 5;

/// Rejection reason codes (same vocabulary as the sellers' off-chain decline reasons).
pub const REASON_MISSING_FIELDS: u8 = 1;
pub const REASON_STALE_DATA: u8 = 2;
pub const REASON_SCHEMA_MISMATCH: u8 = 3;
pub const REASON_INVALID_RESPONSE: u8 = 4;
/// Paid (the x402 transfer landed) but nothing was delivered, e.g. the seller's
/// middleware gave up waiting for settlement confirmation and answered 402.
pub const REASON_NOT_DELIVERED: u8 = 5;

#[program]
pub mod rfq_market {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16, usdc_mint: Pubkey, treasury: Pubkey) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, RfqError::InvalidFee);
        require_keys_eq!(ctx.accounts.usdc_mint.key(), usdc_mint, RfqError::MintMismatch);
        require_keys_eq!(ctx.accounts.treasury.key(), treasury, RfqError::TreasuryMismatch);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = treasury;
        config.fee_bps = fee_bps;
        config.usdc_mint = usdc_mint;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn post_rfq(
        ctx: Context<PostRfq>,
        nonce: u64,
        spec_hash: [u8; 32],
        spec_uri: String,
        max_price: u64,
        deadline: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(deadline > now, RfqError::DeadlineInPast);
        require!(spec_uri.len() <= MAX_URI_LEN, RfqError::UriTooLong);
        require!(max_price > 0, RfqError::ZeroPrice);

        let rfq = &mut ctx.accounts.rfq;
        rfq.buyer = ctx.accounts.buyer.key();
        rfq.nonce = nonce;
        rfq.spec_hash = spec_hash;
        rfq.spec_uri = spec_uri;
        rfq.max_price = max_price;
        rfq.deadline = deadline;
        rfq.status = STATUS_OPEN;
        rfq.awarded_quote = None;
        rfq.created_at = now;
        rfq.bump = ctx.bumps.rfq;

        emit!(RfqPosted {
            rfq: rfq.key(),
            buyer: rfq.buyer,
            nonce,
            spec_hash,
            max_price,
            deadline,
        });
        Ok(())
    }

    pub fn submit_quote(
        ctx: Context<SubmitQuote>,
        price: u64,
        endpoint_hash: [u8; 32],
        endpoint_uri: String,
        expires_at: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let rfq = &ctx.accounts.rfq;
        require!(rfq.status == STATUS_OPEN, RfqError::RfqNotOpen);
        require!(now < rfq.deadline, RfqError::DeadlinePassed);
        require!(price > 0, RfqError::ZeroPrice);
        require!(price <= rfq.max_price, RfqError::PriceAboveMax);
        require!(expires_at > now, RfqError::QuoteExpired);
        require!(endpoint_uri.len() <= MAX_URI_LEN, RfqError::UriTooLong);

        let quote = &mut ctx.accounts.quote;
        quote.rfq = rfq.key();
        quote.seller = ctx.accounts.seller.key();
        quote.price = price;
        quote.endpoint_hash = endpoint_hash;
        quote.endpoint_uri = endpoint_uri;
        quote.expires_at = expires_at;
        quote.created_at = now;
        quote.bump = ctx.bumps.quote;

        emit!(QuoteSubmitted {
            rfq: quote.rfq,
            quote: quote.key(),
            seller: quote.seller,
            price,
            expires_at,
        });
        Ok(())
    }

    /// Catalog quote: the buyer records, on behalf of a seller listed in the x402 Endpoint
    /// catalog, the price that seller's endpoint advertised in its 402 response. The seller
    /// never signs; the Quote's `seller` is a per-host PDA (["catalog_seller", sha256(host)]),
    /// so catalog sellers aggregate by host. A CatalogQuote PDA (["catalog", quote]) marks the
    /// source and stores the advertised pay-to address and network. Award, payment and
    /// fulfillment/rejection then follow the normal flow.
    pub fn submit_catalog_quote(
        ctx: Context<SubmitCatalogQuote>,
        host: String,
        host_hash: [u8; 32],
        price: u64,
        endpoint_hash: [u8; 32],
        endpoint_uri: String,
        expires_at: i64,
        pay_to: String,
        network: String,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let rfq = &ctx.accounts.rfq;
        require!(rfq.status == STATUS_OPEN, RfqError::RfqNotOpen);
        require!(now < rfq.deadline, RfqError::DeadlinePassed);
        require!(price > 0, RfqError::ZeroPrice);
        require!(price <= rfq.max_price, RfqError::PriceAboveMax);
        require!(expires_at > now, RfqError::QuoteExpired);
        require!(endpoint_uri.len() <= MAX_URI_LEN, RfqError::UriTooLong);
        require!(!host.is_empty() && host.len() <= MAX_HOST_LEN, RfqError::BadCatalogField);
        require!(!pay_to.is_empty() && pay_to.len() <= MAX_PAY_TO_LEN, RfqError::BadCatalogField);
        require!(!network.is_empty() && network.len() <= MAX_NETWORK_LEN, RfqError::BadCatalogField);
        require!(
            solana_sha256_hasher::hash(host.as_bytes()).to_bytes() == host_hash,
            RfqError::HostHashMismatch
        );

        let seller = ctx.accounts.catalog_seller.key();
        let quote = &mut ctx.accounts.quote;
        quote.rfq = rfq.key();
        quote.seller = seller;
        quote.price = price;
        quote.endpoint_hash = endpoint_hash;
        quote.endpoint_uri = endpoint_uri;
        quote.expires_at = expires_at;
        quote.created_at = now;
        quote.bump = ctx.bumps.quote;

        let meta = &mut ctx.accounts.catalog_quote;
        meta.quote = quote.key();
        meta.rfq = rfq.key();
        meta.recorded_by = ctx.accounts.buyer.key();
        meta.host = host;
        meta.pay_to = pay_to;
        meta.network = network;
        meta.observed_at = now;
        meta.bump = ctx.bumps.catalog_quote;

        emit!(QuoteSubmitted {
            rfq: quote.rfq,
            quote: quote.key(),
            seller,
            price,
            expires_at,
        });
        emit!(CatalogQuoteRecorded {
            rfq: meta.rfq,
            quote: meta.quote,
            seller,
            host: meta.host.clone(),
            pay_to: meta.pay_to.clone(),
            network: meta.network.clone(),
            price,
        });
        Ok(())
    }

    pub fn award(ctx: Context<Award>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let quote = &ctx.accounts.quote;
        require!(ctx.accounts.rfq.status == STATUS_OPEN, RfqError::RfqNotOpen);
        require!(quote.expires_at > now, RfqError::QuoteExpired);

        let fee = (quote.price as u128)
            .checked_mul(ctx.accounts.config.fee_bps as u128)
            .ok_or(RfqError::MathOverflow)?
            / 10_000u128;
        let fee = u64::try_from(fee).map_err(|_| RfqError::MathOverflow)?;

        if fee > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_usdc.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        let rfq = &mut ctx.accounts.rfq;
        rfq.status = STATUS_AWARDED;
        rfq.awarded_quote = Some(quote.key());

        emit!(RfqAwarded {
            rfq: rfq.key(),
            quote: quote.key(),
            seller: quote.seller,
            price: quote.price,
            fee,
        });
        Ok(())
    }

    pub fn record_fulfillment(ctx: Context<RecordFulfillment>, payment_sig: [u8; 64], response_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let rfq = &mut ctx.accounts.rfq;
        require!(rfq.status == STATUS_AWARDED, RfqError::RfqNotAwarded);
        let awarded = rfq.awarded_quote.ok_or(RfqError::RfqNotAwarded)?;
        require_keys_eq!(awarded, ctx.accounts.quote.key(), RfqError::QuoteMismatch);

        let f = &mut ctx.accounts.fulfillment;
        f.rfq = rfq.key();
        f.quote = awarded;
        f.payment_sig = payment_sig;
        f.response_hash = response_hash;
        f.fulfilled_at = now;
        f.bump = ctx.bumps.fulfillment;

        rfq.status = STATUS_FULFILLED;

        emit!(RfqFulfilled {
            rfq: f.rfq,
            quote: f.quote,
            payment_sig,
            response_hash,
        });
        Ok(())
    }

    /// Buyer paid (x402) but the delivered response failed its spec. Records the
    /// rejection on-chain; there is no refund (no escrow by design).
    pub fn record_rejection(
        ctx: Context<RecordRejection>,
        payment_sig: [u8; 64],
        response_hash: [u8; 32],
        reason_code: u8,
    ) -> Result<()> {
        require!(
            (REASON_MISSING_FIELDS..=REASON_NOT_DELIVERED).contains(&reason_code),
            RfqError::InvalidReason
        );
        let now = Clock::get()?.unix_timestamp;
        let rfq = &mut ctx.accounts.rfq;
        require!(rfq.status == STATUS_AWARDED, RfqError::RfqNotAwarded);
        let awarded = rfq.awarded_quote.ok_or(RfqError::RfqNotAwarded)?;
        require_keys_eq!(awarded, ctx.accounts.quote.key(), RfqError::QuoteMismatch);

        let r = &mut ctx.accounts.rejection;
        r.rfq = rfq.key();
        r.quote = awarded;
        r.seller = ctx.accounts.quote.seller;
        r.payment_sig = payment_sig;
        r.response_hash = response_hash;
        r.reason_code = reason_code;
        r.rejected_at = now;
        r.bump = ctx.bumps.rejection;

        rfq.status = STATUS_REJECTED;

        emit!(RfqRejected {
            rfq: r.rfq,
            quote: r.quote,
            seller: r.seller,
            payment_sig,
            response_hash,
            reason_code,
        });
        Ok(())
    }

    /// Seller declares a response-time ceiling for its quote (stored apart from
    /// Quote so existing Quote accounts keep their layout).
    pub fn declare_sla(ctx: Context<DeclareSla>, max_latency_ms: u32) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let rfq = &ctx.accounts.rfq;
        require!(rfq.status == STATUS_OPEN, RfqError::RfqNotOpen);
        require!(now < rfq.deadline, RfqError::DeadlinePassed);
        require!(max_latency_ms > 0, RfqError::InvalidSla);

        let sla = &mut ctx.accounts.sla;
        sla.quote = ctx.accounts.quote.key();
        sla.seller = ctx.accounts.seller.key();
        sla.max_latency_ms = max_latency_ms;
        sla.measured_latency_ms = 0;
        sla.measured = false;
        sla.measured_at = 0;
        sla.bump = ctx.bumps.sla;

        emit!(SlaDeclared { quote: sla.quote, seller: sla.seller, max_latency_ms });
        Ok(())
    }

    /// Buyer records the measured latency of the paid call against the declared SLA.
    pub fn record_latency(ctx: Context<RecordLatency>, measured_latency_ms: u32) -> Result<()> {
        let rfq = &ctx.accounts.rfq;
        require!(
            rfq.status == STATUS_FULFILLED || rfq.status == STATUS_REJECTED,
            RfqError::NotDelivered
        );
        require_keys_eq!(
            rfq.awarded_quote.ok_or(RfqError::RfqNotAwarded)?,
            ctx.accounts.quote.key(),
            RfqError::QuoteMismatch
        );
        let sla = &mut ctx.accounts.sla;
        require!(!sla.measured, RfqError::AlreadyMeasured);
        sla.measured_latency_ms = measured_latency_ms;
        sla.measured = true;
        sla.measured_at = Clock::get()?.unix_timestamp;

        emit!(LatencyRecorded {
            quote: sla.quote,
            seller: sla.seller,
            max_latency_ms: sla.max_latency_ms,
            measured_latency_ms,
            met: measured_latency_ms <= sla.max_latency_ms,
        });
        Ok(())
    }

    pub fn cancel_rfq(ctx: Context<CancelRfq>) -> Result<()> {
        let rfq = &mut ctx.accounts.rfq;
        require!(rfq.status == STATUS_OPEN, RfqError::RfqNotOpen);
        rfq.status = STATUS_CANCELLED;
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub usdc_mint: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Rfq {
    pub buyer: Pubkey,
    pub nonce: u64,
    pub spec_hash: [u8; 32],
    #[max_len(200)]
    pub spec_uri: String,
    pub max_price: u64,
    pub deadline: i64,
    pub status: u8,
    pub awarded_quote: Option<Pubkey>,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Quote {
    pub rfq: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub endpoint_hash: [u8; 32],
    #[max_len(200)]
    pub endpoint_uri: String,
    pub expires_at: i64,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Fulfillment {
    pub rfq: Pubkey,
    pub quote: Pubkey,
    pub payment_sig: [u8; 64],
    pub response_hash: [u8; 32],
    pub fulfilled_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Rejection {
    pub rfq: Pubkey,
    pub quote: Pubkey,
    pub seller: Pubkey,
    pub payment_sig: [u8; 64],
    pub response_hash: [u8; 32],
    pub reason_code: u8,
    pub rejected_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Sla {
    pub quote: Pubkey,
    pub seller: Pubkey,
    pub max_latency_ms: u32,
    pub measured_latency_ms: u32,
    pub measured: bool,
    pub measured_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CatalogQuote {
    pub quote: Pubkey,
    pub rfq: Pubkey,
    pub recorded_by: Pubkey,
    #[max_len(100)]
    pub host: String,
    #[max_len(64)]
    pub pay_to: String,
    #[max_len(64)]
    pub network: String,
    pub observed_at: i64,
    pub bump: u8,
}

// ---------------------------------------------------------------- contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(token::mint = usdc_mint)]
    pub treasury: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct PostRfq<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Rfq::INIT_SPACE,
        seeds = [b"rfq", buyer.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub rfq: Account<'info, Rfq>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitQuote<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub rfq: Account<'info, Rfq>,
    #[account(
        init,
        payer = seller,
        space = 8 + Quote::INIT_SPACE,
        seeds = [b"quote", rfq.key().as_ref(), seller.key().as_ref()],
        bump
    )]
    pub quote: Account<'info, Quote>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(host: String, host_hash: [u8; 32])]
pub struct SubmitCatalogQuote<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(has_one = buyer @ RfqError::NotBuyer)]
    pub rfq: Account<'info, Rfq>,
    /// CHECK: address-only PDA identifying a catalog seller by host; holds no data.
    #[account(seeds = [b"catalog_seller", host_hash.as_ref()], bump)]
    pub catalog_seller: UncheckedAccount<'info>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Quote::INIT_SPACE,
        seeds = [b"quote", rfq.key().as_ref(), catalog_seller.key().as_ref()],
        bump
    )]
    pub quote: Account<'info, Quote>,
    #[account(
        init,
        payer = buyer,
        space = 8 + CatalogQuote::INIT_SPACE,
        seeds = [b"catalog", quote.key().as_ref()],
        bump
    )]
    pub catalog_quote: Account<'info, CatalogQuote>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Award<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = buyer @ RfqError::NotBuyer)]
    pub rfq: Account<'info, Rfq>,
    #[account(
        seeds = [b"quote", rfq.key().as_ref(), quote.seller.as_ref()],
        bump = quote.bump,
        constraint = quote.rfq == rfq.key() @ RfqError::QuoteMismatch
    )]
    pub quote: Account<'info, Quote>,
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = buyer
    )]
    pub buyer_usdc: Account<'info, TokenAccount>,
    #[account(mut, address = config.treasury @ RfqError::TreasuryMismatch)]
    pub treasury: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RecordFulfillment<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer @ RfqError::NotBuyer)]
    pub rfq: Account<'info, Rfq>,
    #[account(constraint = quote.rfq == rfq.key() @ RfqError::QuoteMismatch)]
    pub quote: Account<'info, Quote>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Fulfillment::INIT_SPACE,
        seeds = [b"fulfillment", rfq.key().as_ref()],
        bump
    )]
    pub fulfillment: Account<'info, Fulfillment>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelRfq<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer @ RfqError::NotBuyer)]
    pub rfq: Account<'info, Rfq>,
}

#[derive(Accounts)]
pub struct RecordRejection<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer @ RfqError::NotBuyer)]
    pub rfq: Account<'info, Rfq>,
    #[account(constraint = quote.rfq == rfq.key() @ RfqError::QuoteMismatch)]
    pub quote: Account<'info, Quote>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Rejection::INIT_SPACE,
        seeds = [b"rejection", rfq.key().as_ref()],
        bump
    )]
    pub rejection: Account<'info, Rejection>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeclareSla<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub rfq: Account<'info, Rfq>,
    #[account(
        seeds = [b"quote", rfq.key().as_ref(), seller.key().as_ref()],
        bump = quote.bump,
        has_one = seller @ RfqError::NotSeller,
        constraint = quote.rfq == rfq.key() @ RfqError::QuoteMismatch
    )]
    pub quote: Account<'info, Quote>,
    #[account(
        init,
        payer = seller,
        space = 8 + Sla::INIT_SPACE,
        seeds = [b"sla", quote.key().as_ref()],
        bump
    )]
    pub sla: Account<'info, Sla>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordLatency<'info> {
    pub buyer: Signer<'info>,
    #[account(has_one = buyer @ RfqError::NotBuyer)]
    pub rfq: Account<'info, Rfq>,
    #[account(constraint = quote.rfq == rfq.key() @ RfqError::QuoteMismatch)]
    pub quote: Account<'info, Quote>,
    #[account(mut, seeds = [b"sla", quote.key().as_ref()], bump = sla.bump)]
    pub sla: Account<'info, Sla>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct RfqPosted {
    pub rfq: Pubkey,
    pub buyer: Pubkey,
    pub nonce: u64,
    pub spec_hash: [u8; 32],
    pub max_price: u64,
    pub deadline: i64,
}

#[event]
pub struct QuoteSubmitted {
    pub rfq: Pubkey,
    pub quote: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub expires_at: i64,
}

#[event]
pub struct RfqAwarded {
    pub rfq: Pubkey,
    pub quote: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub fee: u64,
}

#[event]
pub struct RfqFulfilled {
    pub rfq: Pubkey,
    pub quote: Pubkey,
    pub payment_sig: [u8; 64],
    pub response_hash: [u8; 32],
}

#[event]
pub struct RfqRejected {
    pub rfq: Pubkey,
    pub quote: Pubkey,
    pub seller: Pubkey,
    pub payment_sig: [u8; 64],
    pub response_hash: [u8; 32],
    pub reason_code: u8,
}

#[event]
pub struct SlaDeclared {
    pub quote: Pubkey,
    pub seller: Pubkey,
    pub max_latency_ms: u32,
}

#[event]
pub struct LatencyRecorded {
    pub quote: Pubkey,
    pub seller: Pubkey,
    pub max_latency_ms: u32,
    pub measured_latency_ms: u32,
    pub met: bool,
}

#[event]
pub struct CatalogQuoteRecorded {
    pub rfq: Pubkey,
    pub quote: Pubkey,
    pub seller: Pubkey,
    pub host: String,
    pub pay_to: String,
    pub network: String,
    pub price: u64,
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum RfqError {
    #[msg("fee_bps must be <= 10000")]
    InvalidFee,
    #[msg("usdc_mint argument does not match account")]
    MintMismatch,
    #[msg("treasury does not match config")]
    TreasuryMismatch,
    #[msg("deadline must be in the future")]
    DeadlineInPast,
    #[msg("URI exceeds 200 bytes")]
    UriTooLong,
    #[msg("price must be > 0")]
    ZeroPrice,
    #[msg("RFQ is not open")]
    RfqNotOpen,
    #[msg("RFQ deadline has passed")]
    DeadlinePassed,
    #[msg("quote price exceeds RFQ max_price")]
    PriceAboveMax,
    #[msg("quote has expired")]
    QuoteExpired,
    #[msg("signer is not the RFQ buyer")]
    NotBuyer,
    #[msg("quote does not belong to this RFQ / award")]
    QuoteMismatch,
    #[msg("RFQ has not been awarded")]
    RfqNotAwarded,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("unknown rejection reason code")]
    InvalidReason,
    #[msg("max_latency_ms must be > 0")]
    InvalidSla,
    #[msg("signer is not the quote seller")]
    NotSeller,
    #[msg("RFQ has not been delivered (fulfilled or rejected)")]
    NotDelivered,
    #[msg("latency already recorded")]
    AlreadyMeasured,
    #[msg("catalog host / pay_to / network empty or too long")]
    BadCatalogField,
    #[msg("host_hash is not sha256(host)")]
    HostHashMismatch,
}
