using System;
namespace Fixture;
public interface IDamageable { void Damage(int amount); }
public partial class Hero : IDamageable
{
    public int Health = 100;
    public int DisplayHealth { get => Health; set => Health = value; }
    public event Action<int>? Changed;
    public void Damage(int amount)
    {
        if (amount > 0)
        {
            Health -= amount;
            Changed?.Invoke(Health);
        }
    }
    public void Damage(string text) { Damage(text.Length); }
    public void Bind() { Changed += OnChanged; Changed -= OnChanged; }
    void OnChanged(int amount) { Health = amount; }
    public void ViaInterface(IDamageable target) { target.Damage(1); }
    public void Callback() { Action action = () => Damage(1); action(); }
    public void RefArgument() { Change(ref Health); }
    static void Change(ref int value) { value++; }
    public void NestedStorage(Hero other) { other.Health = Health; }
    public string HealthName() { return nameof(Health); }
    public object Anonymous() { return new { Value = Health }; }
    public void TupleWrite() { (Health, DisplayHealth) = (1, 2); }
}
