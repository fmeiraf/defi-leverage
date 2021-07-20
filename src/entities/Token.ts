import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity()
export class Token {
  @PrimaryKey()
  token_id!: number;

  @Property()
  token_address!: string;

  @Property()
  token_ERC_code!: string;

  @Property()
  token_code_on_protocol!: string;

  @Property()
  decimals!: number;

  @Property({ type: "date", onUpdate: () => new Date() })
  updatedAt = new Date();

  @Property({ default: 0 })
  liquidation_ratio_maker!: number;
}
