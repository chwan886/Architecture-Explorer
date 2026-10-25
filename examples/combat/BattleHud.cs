namespace Demo;

public sealed class BattleHud
{
    public string Render(Actor actor)
    {
        return $"HP: {actor.Health}";
    }
}
