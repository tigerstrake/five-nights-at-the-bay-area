// A seat controller accepts only role projections. Never pass GameState to this module.
import { AI_PLAYER_CONFIG, createRng, type AiDifficulty, type BalanceConfig, type GameAction, type Graph, type PlayerView, type Rng } from '@fnab/shared';
import { DefenderBot, MonsterBot } from './policies';

export class AiPlayer {
  private readonly defender?: DefenderBot;
  private readonly monster?: MonsterBot;
  private readonly rng: Rng;
  private nextObserve: number;

  constructor(readonly role: 'monster' | 'defender', readonly difficulty: AiDifficulty, graph: Graph, cfg: BalanceConfig, seed: number) {
    this.rng = createRng(seed);
    this.nextObserve = this.rng.range(...AI_PLAYER_CONFIG.initialStaggerMs);
    if (role === 'defender') {
      // Each seat is one operator. Multiplying the collective harness attention by seat count would double-scale it.
      this.defender = new DefenderBot(difficulty, graph, cfg, createRng(this.rng.int(0, 0x7fffffff)), 1);
    } else {
      this.monster = new MonsterBot('adaptive', graph, cfg, createRng(this.rng.int(0, 0x7fffffff)));
      this.nextObserve += this.rng.range(...AI_PLAYER_CONFIG.monsterReactionMs[difficulty]);
    }
  }

  due(t: number): boolean { return t >= this.nextObserve; }

  act(view: PlayerView): GameAction | null {
    if (view.role !== this.role || view.ended || !this.due(view.t)) return null;
    this.nextObserve = view.t + (this.monster
      ? Math.max(AI_PLAYER_CONFIG.observeMs, this.rng.range(...AI_PLAYER_CONFIG.monsterReactionMs[this.difficulty]))
      : AI_PLAYER_CONFIG.observeMs);
    return view.role === 'monster' ? this.monster!.act(view) : this.defender!.act(view);
  }
}
