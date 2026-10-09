use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp");

pub const MAX_URI_LEN: usize = 200;
pub const MAX_FEE_BPS: u16 = 10_000;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_AWARDED: u8 = 1;
pub const STATUS_FULFILLED: u8 = 2;
pub const STATUS_CANCELLED: u8 = 3;
#[allow(dead_code)]
pub const STATUS_EXPIRED: u8 = 4;

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
}
