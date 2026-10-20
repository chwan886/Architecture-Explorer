namespace Fixture;
public partial class Hero
{
    public void Heal(int amount) { Health += amount; }
    public void Local() { void Apply() { Health++; } Apply(); }
}
